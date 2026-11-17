// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BatchDesk, IERC20} from "../src/BatchDesk.sol";

interface Vm { function prank(address) external; function expectRevert(bytes4) external; function warp(uint256) external; }

contract Tok { mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
  function mint(address a, uint256 v) external { balanceOf[a] += v; }
  function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
  function transfer(address t, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[t] += v; return true; }
  function transferFrom(address f, address t, uint256 v) external returns (bool) { allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[t] += v; return true; } }

contract BatchDeskUnit {
  Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  address constant BUYER = address(0xB0);
  address constant WORKER = address(0xCA7);
  address constant LENDER = address(0x1E);
  address constant OTHER = address(0xBAD);
  uint32 constant DAY = 86400;
  function setup() internal returns (Tok t, BatchDesk b, bytes32 id) {
    t = new Tok(); b = new BatchDesk(IERC20(address(t)));
    t.mint(BUYER, 100e6); vm.prank(BUYER); t.approve(address(b), type(uint256).max);
    vm.prank(BUYER); id = b.open(WORKER, 0.7e6, DAY, "100 trails"); vm.prank(BUYER); b.fund(id, 70e6);
  }
  function test_batchPricePaidPerItem_buyerReleasesAtOnce() public {
    (Tok t, BatchDesk b, bytes32 id) = setup();
    vm.prank(WORKER); b.deliver(id, "FROGE", keccak256("trail"));
    vm.prank(BUYER); b.release(id, "FROGE");
    require(t.balanceOf(WORKER) == 0.7e6, "paid the batch price");
    vm.prank(WORKER); vm.expectRevert(BatchDesk.WrongState.selector); b.deliver(id, "FROGE", keccak256("again"));
  }
  function test_anyoneReleasesAfterWindow_notBefore() public {
    (Tok t, BatchDesk b, bytes32 id) = setup();
    vm.prank(WORKER); b.deliver(id, "A", keccak256("a"));
    vm.prank(OTHER); vm.expectRevert(BatchDesk.WindowOpen.selector); b.release(id, "A");
    vm.warp(block.timestamp + DAY);
    vm.prank(OTHER); b.release(id, "A");
    require(t.balanceOf(WORKER) == 0.7e6, "released by a stranger after the window");
  }
  function test_disputeInsideWindowReturnsPrice_afterWindowFails() public {
    (Tok t, BatchDesk b, bytes32 id) = setup();
    vm.prank(WORKER); b.deliver(id, "A", keccak256("a"));
    vm.prank(WORKER); b.deliver(id, "B", keccak256("b"));
    vm.prank(BUYER); b.dispute(id, "A");
    (,,,, uint256 bal, uint256 held) = b.desks(id);
    require(bal == 69.3e6 && held == 0.7e6, "A back on the desk, B held");
    vm.warp(block.timestamp + DAY);
    vm.prank(BUYER); vm.expectRevert(BatchDesk.WindowClosed.selector); b.dispute(id, "B");
    vm.prank(OTHER); vm.expectRevert(BatchDesk.WrongState.selector); b.release(id, "A");
    require(t.balanceOf(WORKER) == 0, "nothing paid yet");
  }
  function test_onlyWorkerDelivers_onlyBuyerDisputesAndWithdraws() public {
    (, BatchDesk b, bytes32 id) = setup();
    vm.prank(OTHER); vm.expectRevert(BatchDesk.NotWorker.selector); b.deliver(id, "A", keccak256("a"));
    vm.prank(WORKER); b.deliver(id, "A", keccak256("a"));
    vm.prank(OTHER); vm.expectRevert(BatchDesk.NotBuyer.selector); b.dispute(id, "A");
    vm.prank(WORKER); vm.expectRevert(BatchDesk.NotBuyer.selector); b.withdraw(id, 1);
  }
  function test_withdrawNeverTouchesHeld_emptyDeskStopsDelivery() public {
    (Tok t, BatchDesk b, bytes32 id) = setup();
    vm.prank(WORKER); b.deliver(id, "A", keccak256("a"));
    vm.prank(BUYER); vm.expectRevert(BatchDesk.BadInput.selector); b.withdraw(id, 70e6);
    vm.prank(BUYER); b.withdraw(id, 69.3e6);
    vm.prank(WORKER); vm.expectRevert(BatchDesk.Empty.selector); b.deliver(id, "B", keccak256("b"));
    vm.warp(block.timestamp + DAY); b.release(id, "A");
    require(t.balanceOf(WORKER) == 0.7e6 && t.balanceOf(BUYER) == 99.3e6, "held item still paid; rest withdrawn");
  }
  function test_aLenderCanFundTheBuyersDesk() public {
    (Tok t, BatchDesk b, bytes32 id) = setup();
    t.mint(LENDER, 35e6); vm.prank(LENDER); t.approve(address(b), type(uint256).max);
    vm.prank(LENDER); b.fund(id, 35e6);
    (,,,, uint256 bal,) = b.desks(id);
    require(bal == 105e6, "lender topped up");
  }
  function test_releaseMany() public {
    (Tok t, BatchDesk b, bytes32 id) = setup();
    bytes32[] memory l = new bytes32[](3); l[0] = "A"; l[1] = "B"; l[2] = "C";
    for (uint256 i; i < 3; ++i) { vm.prank(WORKER); b.deliver(id, l[i], keccak256(abi.encode(i))); }
    vm.prank(BUYER); b.releaseMany(id, l);
    require(t.balanceOf(WORKER) == 2.1e6, "three paid");
  }
  function test_deskIsPerBuyer_cannotReopen() public {
    (, BatchDesk b,) = setup();
    vm.prank(BUYER); vm.expectRevert(BatchDesk.BadInput.selector); b.open(WORKER, 1e6, DAY, "100 trails");
    vm.prank(OTHER); b.open(WORKER, 1e6, DAY, "100 trails"); // same label, different buyer: its own desk
  }
}

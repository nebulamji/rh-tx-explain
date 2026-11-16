// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ReadEscrow, IERC20, ILineVault} from "../src/ReadEscrow.sol";

interface Vm { function prank(address) external; function expectRevert(bytes4) external; }
interface IBal { function balanceOf(address) external view returns (uint256); function approve(address, uint256) external returns (bool); }

contract Tok { mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
  function mint(address a, uint256 v) external { balanceOf[a] += v; }
  function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
  function transfer(address t, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[t] += v; return true; }
  function transferFrom(address f, address t, uint256 v) external returns (bool) { allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[t] += v; return true; } }

contract MockVault is ILineVault { struct L { address w; uint256 lim; } mapping(uint256 => L) public l;
  function set(uint256 id, address w, uint256 lim) external { l[id] = L(w, lim); }
  function lines(uint256 id) external view returns (address, uint256, uint256, uint256, uint256) { return (l[id].w, l[id].lim, 0, 0, 0); } }

contract ReadEscrowUnit {
  Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  address constant FUNDER = address(0xF0);
  address constant READER = address(0xCA7);
  address constant OTHER = address(0xBAD);
  function setup() internal returns (Tok t, MockVault v, ReadEscrow e, bytes32 id) {
    t = new Tok(); v = new MockVault(); e = new ReadEscrow(IERC20(address(t)));
    t.mint(FUNDER, 10e6); vm.prank(FUNDER); t.approve(address(e), type(uint256).max);
    vm.prank(FUNDER); id = e.open(address(v), READER, 1e6); vm.prank(FUNDER); e.fund(id, 3e6);
  }
  function test_paysOncePerLine_newWalletIsNewLine() public {
    (Tok t, MockVault v, ReadEscrow e, bytes32 id) = setup();
    v.set(7, address(0x11), 5e6);
    e.deliver(id, 7, keccak256("read 1")); require(t.balanceOf(READER) == 1e6, "paid");
    vm.expectRevert(ReadEscrow.AlreadyRead.selector); e.deliver(id, 7, keccak256("again"));
    v.set(7, address(0x22), 5e6); // the agent ID sold: new wallet, new line
    e.deliver(id, 7, keccak256("read 2")); require(t.balanceOf(READER) == 2e6, "paid twice");
  }
  function test_noLineNoPay() public {
    (, MockVault v, ReadEscrow e, bytes32 id) = setup();
    vm.expectRevert(ReadEscrow.NoLine.selector); e.deliver(id, 9, keccak256("x"));
    v.set(9, address(0x33), 0); // closed line
    vm.expectRevert(ReadEscrow.NoLine.selector); e.deliver(id, 9, keccak256("x"));
  }
  function test_skipAndEmptyAndWithdraw() public {
    (Tok t, MockVault v, ReadEscrow e, bytes32 id) = setup();
    v.set(1, address(0x1), 1e6); v.set(2, address(0x2), 1e6); v.set(3, address(0x3), 1e6); v.set(4, address(0x4), 1e6); v.set(5, address(0x5), 1e6);
    uint256[] memory s = new uint256[](1); s[0] = 1;
    vm.expectRevert(ReadEscrow.NotFunder.selector); e.skip(id, s);
    vm.prank(FUNDER); e.skip(id, s);
    vm.expectRevert(ReadEscrow.AlreadyRead.selector); e.deliver(id, 1, keccak256("x"));
    e.deliver(id, 2, keccak256("a")); e.deliver(id, 3, keccak256("b")); e.deliver(id, 4, keccak256("c"));
    vm.expectRevert(ReadEscrow.Empty.selector); e.deliver(id, 5, keccak256("d"));
    vm.prank(FUNDER); e.fund(id, 2e6);
    vm.expectRevert(ReadEscrow.NotFunder.selector); e.withdraw(id, 1e6);
    vm.prank(FUNDER); e.withdraw(id, 2e6); require(t.balanceOf(FUNDER) == 5e6 + 2e6, "walk away");
    vm.expectRevert(ReadEscrow.Empty.selector); e.deliver(id, 5, keccak256("d"));
  }
  function test_noSquat() public {
    (Tok t, MockVault v, ReadEscrow e, bytes32 id) = setup();
    vm.prank(OTHER); bytes32 id2 = e.open(address(v), OTHER, 1e6);
    require(id2 != id, "separate desk"); v.set(7, address(0x11), 5e6);
    e.deliver(id, 7, keccak256("r")); require(t.balanceOf(READER) == 1e6 && t.balanceOf(OTHER) == 0, "funder's desk pays its reader");
  }
}

// Robinhood Chain mainnet fork: real USDG, real Bank of Me v2, real line #8811, real JazzCat #1 wallet.
contract ReadEscrowFork {
  Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
  address constant VAULT = 0x9fB39e4338ceacf54E3918477293396e1300e96F;
  address constant OWNER = 0x33d6112f2F3BCD2a476bD9C13208E4C632bE2d0a;
  address constant CAT1 = 0x1479bE07E26976Fd712db34f7Bc1B8Ac523f806e;
  function test_fork_bankOfMeV2() public {
    if (block.chainid != 4663) return;
    ReadEscrow e = new ReadEscrow(IERC20(USDG));
    vm.prank(OWNER); bytes32 id = e.open(VAULT, CAT1, 1e6);
    vm.prank(VAULT); IBal(USDG).approve(address(e), 2e6); // the fork's USDG comes from the vault's 5 USDG
    vm.prank(VAULT); e.fund(id, 2e6);
    uint256 before = IBal(USDG).balanceOf(CAT1);
    e.deliver(id, 8811, keccak256("line read #8811"));
    require(IBal(USDG).balanceOf(CAT1) == before + 1e6, "Cat paid 1 USDG for line #8811");
    vm.expectRevert(ReadEscrow.AlreadyRead.selector); e.deliver(id, 8811, keccak256("again"));
    vm.expectRevert(ReadEscrow.NoLine.selector); e.deliver(id, 26026, keccak256("no line"));
    vm.prank(OWNER); e.withdraw(id, 1e6);
  }
}

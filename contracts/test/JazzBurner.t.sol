// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {JazzBurner} from "../src/JazzBurner.sol";
interface Vm { function prank(address) external; function expectRevert(bytes4) external; function warp(uint256) external; }

contract Tok { mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
  function mint(address to, uint256 v) external { balanceOf[to] += v; }
  function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
  function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
  function transferFrom(address f, address to, uint256 v) external returns (bool) { allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; return true; } }
/// A stand-in router: takes `amountIn` USDG and pays `out` JAZZ (it can be told to overspend, to prove the cap holds).
contract Router { Tok usdg; Tok jazz; constructor(Tok u, Tok j) { usdg = u; jazz = j; }
  function buy(uint256 amountIn, uint256 out) external { usdg.transferFrom(msg.sender, address(this), amountIn); jazz.mint(msg.sender, out); } }

contract Chain { uint64 public count = 97; bytes32 public head = bytes32(uint256(0xe98a)); }
contract OldBook { uint64 public count = 96; }
contract JazzBurnerTest {
  Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  function test_burnerSwapsUnderCapBurnsAllAndNamesTheChain() public {
    Tok usdg = new Tok(); Tok jazz = new Tok(); Router r = new Router(usdg, jazz); Chain c = new Chain();
    JazzBurner b = new JazzBurner(address(usdg), address(jazz), address(c), address(this), address(r), 25e6, 3600);
    usdg.mint(address(b), 60e6);
    vm.warp(10_000);
    uint256 burned = b.burn(10e6, 900e18, abi.encodeCall(Router.buy, (10e6, 1000e18)));
    require(burned == 1000e18 && jazz.balanceOf(b.DEAD()) == 1000e18 && jazz.balanceOf(address(b)) == 0, "all of it burned");
    require(usdg.balanceOf(address(b)) == 50e6, "spent exactly usdgIn");
    vm.expectRevert(JazzBurner.TooSoon.selector); b.burn(1e6, 0, abi.encodeCall(Router.buy, (1e6, 1)));
    vm.warp(10_000 + 3600);
    vm.expectRevert(JazzBurner.OverCap.selector); b.burn(26e6, 0, abi.encodeCall(Router.buy, (26e6, 1)));
    vm.expectRevert(JazzBurner.SwapFailed.selector); b.burn(1e6, 0, abi.encodeCall(Router.buy, (5e6, 1))); // the exact approval stops an overspend
    vm.expectRevert(JazzBurner.TooLittle.selector); b.burn(1e6, 10e18, abi.encodeCall(Router.buy, (1e6, 1e18)));
    vm.prank(address(0xBAD)); vm.expectRevert(JazzBurner.NotAdmin.selector); b.setRouter(address(0xBAD));
  }
  function test_burnerWorksWithTheFirstBookToo() public {
    Tok usdg = new Tok(); Tok jazz = new Tok(); Router r = new Router(usdg, jazz); OldBook c = new OldBook();
    JazzBurner b = new JazzBurner(address(usdg), address(jazz), address(c), address(this), address(r), 25e6, 0);
    usdg.mint(address(b), 5e6);
    require(b.burn(5e6, 1, abi.encodeCall(Router.buy, (5e6, 7e18))) == 7e18, "burns against a book with no head");
  }
}

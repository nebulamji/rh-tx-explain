// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ReceiptBook} from "../src/ReceiptBook.sol";
interface Vm { function prank(address) external; function expectRevert(bytes4) external; }
contract ReceiptBookUnit {
  Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  function test_writerRecordsInSequence_othersCannot() public {
    ReceiptBook b = new ReceiptBook(address(this));
    require(b.record(address(1), 1e6, address(2), 4663, bytes32(uint256(3)), bytes32(uint256(4)), "trail") == 1, "seq 1");
    require(b.record(address(1), 3e6, address(2), 4663, bytes32(uint256(5)), bytes32(uint256(6)), "audit") == 2, "seq 2");
    vm.prank(address(0xBAD)); vm.expectRevert(ReceiptBook.NotWriter.selector); b.record(address(1), 1, address(2), 1, 0, 0, "x");
    require(b.count() == 2, "count");
  }
}

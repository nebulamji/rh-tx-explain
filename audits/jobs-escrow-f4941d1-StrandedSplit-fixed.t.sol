// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {JobsEscrow} from "../src/JobsEscrow.sol";

/// A buyer that funds, disputes, and refuses ETH. Nothing else.
contract RejectingBuyer {
    JobsEscrow immutable e;

    constructor(JobsEscrow _e) payable {
        e = _e;
    }

    function fund(address worker, uint64 expiry) external returns (uint256) {
        return e.deposit{value: 1 ether}(worker, address(0), 1 ether, expiry);
    }

    function disputeJob(uint256 id) external {
        e.dispute(id);
    }

    receive() external payable {
        revert("no ETH");
    }
}

/// Finding M-1, fixed with pull payments: the 50/50 timeout credits each share instead of pushing both in
/// one transaction. A buyer that rejects ETH can no longer block the worker's half, and no share pays twice.
contract StrandedSplitTest is Test {
    JobsEscrow e;
    address worker = address(0xBEEF);

    function setUp() public {
        e = new JobsEscrow();
        vm.deal(address(this), 10 ether);
    }

    function test_rejectingBuyer_cannotBlockWorker() public {
        RejectingBuyer b = new RejectingBuyer{value: 1 ether}(e);
        uint256 id = b.fund(worker, uint64(block.timestamp + 7 days));
        vm.prank(worker);
        e.claim(id);
        vm.prank(worker);
        e.deliver(id, keccak256("report"));
        b.disputeJob(id); // inside the 3-day review window

        vm.warp(block.timestamp + 31 days);
        vm.prank(worker);
        e.resolveAfterTimeout(id); // fixed: resolution credits both shares instead of pushing them

        (,,,,,, JobsEscrow.Status s) = e.jobs(id);
        assertEq(uint8(s), uint8(JobsEscrow.Status.Resolved));
        uint256 w0 = worker.balance;
        vm.prank(worker);
        e.withdraw(id); // the worker collects its half even though the buyer rejects ETH
        assertEq(worker.balance - w0, 0.5 ether);
        vm.prank(worker);
        vm.expectRevert(JobsEscrow.NothingOwed.selector);
        e.withdraw(id); // nothing can be withdrawn twice
        vm.prank(address(b));
        vm.expectRevert(JobsEscrow.TransferFailed.selector);
        e.withdraw(id); // the rejecting buyer only blocks itself
        assertEq(e.owed(id, address(b)), 0.5 ether); // its share stays credited
        assertEq(address(e).balance, 0.5 ether);
    }
}

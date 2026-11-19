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

/// Finding M-1: the 50/50 timeout pays both parties in one transaction, so a party that cannot receive
/// blocks the other party's share for good. Here the buyer rejects ETH: after the 30-day timeout the
/// worker's resolveAfterTimeout reverts, the buyer never matches a proposal, and the 1 ETH stays locked.
contract StrandedSplitTest is Test {
    JobsEscrow e;
    address worker = address(0xBEEF);

    function setUp() public {
        e = new JobsEscrow();
        vm.deal(address(this), 10 ether);
    }

    function test_rejectingBuyer_strandsWorkerShare() public {
        RejectingBuyer b = new RejectingBuyer{value: 1 ether}(e);
        uint256 id = b.fund(worker, uint64(block.timestamp + 7 days));
        vm.prank(worker);
        e.claim(id);
        vm.prank(worker);
        e.deliver(id, keccak256("report"));
        b.disputeJob(id); // inside the 3-day review window

        vm.warp(block.timestamp + 31 days);
        vm.prank(worker);
        vm.expectRevert(JobsEscrow.TransferFailed.selector);
        e.resolveAfterTimeout(id); // the worker cannot collect its half

        vm.prank(worker);
        e.proposeResolution(id, 1 ether / 2); // the buyer contract never matches

        (,,,,,, JobsEscrow.Status s) = e.jobs(id);
        assertEq(uint8(s), uint8(JobsEscrow.Status.Disputed)); // still locked
        assertEq(address(e).balance, 1 ether);
    }
}

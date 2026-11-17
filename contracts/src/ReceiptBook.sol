// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReceiptBook
/// @notice New Jazz City's sequenced receipts. One row per paid job, in order: who paid, how much, the payment
///         transaction, what was delivered (the hash of the published work) and a short label. Written by one fixed
///         writer, never edited, never deleted. Anyone can read the book and check each row's payment on chain.
contract ReceiptBook {
    struct Receipt {
        uint64 seq;
        uint64 at;
        address buyer;
        uint256 amount; // in the payment token's base units
        address token;
        uint256 chainId; // where the payment settled
        bytes32 payTx;
        bytes32 workHash;
        string label;
    }

    address public immutable writer;
    uint64 public count;

    event Recorded(uint64 indexed seq, address indexed buyer, address indexed token, uint256 amount, uint256 chainId, bytes32 payTx, bytes32 workHash, string label);

    error NotWriter();

    constructor(address _writer) {
        writer = _writer;
    }

    function record(address buyer, uint256 amount, address token, uint256 chainId, bytes32 payTx, bytes32 workHash, string calldata label) external returns (uint64 seq) {
        if (msg.sender != writer) revert NotWriter();
        seq = ++count;
        emit Recorded(seq, buyer, token, amount, chainId, payTx, workHash, label);
    }
}

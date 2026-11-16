// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice Any lender vault that exposes lines by agent ID (Bank of Me v2 shape).
interface ILineVault {
    function lines(uint256 agentId) external view returns (address wallet, uint256 limit, uint256 drawn, uint256 borrows, uint256 repays);
}

/// @title ReadEscrow
/// @notice Pay-per-read on chain. A lender opens a desk for its vault, names a reader and a price, and funds it.
///         For every line the vault really holds (agent ID + wallet, limit above zero), anyone can call `deliver`
///         with the hash of the published read; the contract checks the line on the vault itself and pays the
///         reader once per line. A new wallet for the same agent is a new line. The funder can withdraw the
///         rest at any time. No owner, no admin, no upgrade.
/// @dev    The contract proves a line exists and a read was committed for it. It cannot judge the read.
contract ReadEscrow {
    struct Desk {
        address funder;
        address vault;
        address reader;
        uint96 price;
        uint256 balance;
    }

    IERC20 public immutable usdg;
    mapping(bytes32 => Desk) public desks;
    mapping(bytes32 => mapping(bytes32 => bytes32)) public readOf; // desk => line key => read hash (nonzero once paid)

    event DeskOpened(bytes32 indexed desk, address indexed funder, address indexed vault, address reader, uint256 price);
    event Funded(bytes32 indexed desk, address indexed by, uint256 amount);
    event Delivered(bytes32 indexed desk, uint256 indexed agentId, address wallet, bytes32 readHash, uint256 paid);
    event Skipped(bytes32 indexed desk, uint256 indexed agentId, address wallet);
    event Withdrawn(bytes32 indexed desk, uint256 amount);

    error NotFunder();
    error NoLine();
    error AlreadyRead();
    error Empty();
    error BadInput();
    error TransferFailed();

    constructor(IERC20 _usdg) {
        usdg = _usdg;
    }

    function deskId(address funder, address vault) public pure returns (bytes32) {
        return keccak256(abi.encode(funder, vault));
    }

    function lineKey(uint256 agentId, address wallet) public pure returns (bytes32) {
        return keccak256(abi.encode(agentId, wallet));
    }

    /// @notice Open (or re-price) the caller's desk for `vault`. Desks are per funder, so nobody can squat a vault.
    function open(address vault, address reader, uint96 price) external returns (bytes32 id) {
        if (vault == address(0) || reader == address(0) || price == 0) revert BadInput();
        id = deskId(msg.sender, vault);
        Desk storage d = desks[id];
        d.funder = msg.sender;
        d.vault = vault;
        d.reader = reader;
        d.price = price;
        emit DeskOpened(id, msg.sender, vault, reader, price);
    }

    function fund(bytes32 id, uint256 amount) external {
        Desk storage d = desks[id];
        if (d.funder == address(0) || amount == 0) revert BadInput();
        d.balance += amount;
        _pull(msg.sender, amount);
        emit Funded(id, msg.sender, amount);
    }

    /// @notice Mark lines that already exist (or that the funder doesn't want read) as not payable.
    function skip(bytes32 id, uint256[] calldata agentIds) external {
        Desk storage d = desks[id];
        if (msg.sender != d.funder) revert NotFunder();
        for (uint256 i; i < agentIds.length; ++i) {
            (address wallet,,,,) = ILineVault(d.vault).lines(agentIds[i]);
            bytes32 k = lineKey(agentIds[i], wallet);
            if (readOf[id][k] == 0) readOf[id][k] = bytes32(uint256(1));
            emit Skipped(id, agentIds[i], wallet);
        }
    }

    /// @notice Pay the reader for a read of a line the vault holds right now. Callable by anyone.
    function deliver(bytes32 id, uint256 agentId, bytes32 readHash) external {
        Desk storage d = desks[id];
        if (d.funder == address(0) || readHash == 0) revert BadInput();
        (address wallet, uint256 limit,,,) = ILineVault(d.vault).lines(agentId);
        if (wallet == address(0) || limit == 0) revert NoLine();
        bytes32 k = lineKey(agentId, wallet);
        if (readOf[id][k] != 0) revert AlreadyRead();
        uint256 price = d.price;
        if (d.balance < price) revert Empty();
        readOf[id][k] = readHash;
        d.balance -= price;
        _send(d.reader, price);
        emit Delivered(id, agentId, wallet, readHash, price);
    }

    function withdraw(bytes32 id, uint256 amount) external {
        Desk storage d = desks[id];
        if (msg.sender != d.funder) revert NotFunder();
        if (amount > d.balance) revert BadInput();
        d.balance -= amount;
        _send(msg.sender, amount);
        emit Withdrawn(id, amount);
    }

    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory ret) = address(usdg).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _send(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(usdg).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}

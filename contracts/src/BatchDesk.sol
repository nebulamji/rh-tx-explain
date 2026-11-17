// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @title BatchDesk
/// @notice Batch work paid per item, on chain. A buyer opens a desk naming a worker, a price per item and a review
///         window, and funds it once (a batch price: 100 items at 0.70 USDG each instead of 1). The worker delivers
///         each item by committing the hash of the published work under an item key (a coin, a file, a job id).
///         The price is held per item; the buyer can release it at once, or dispute it inside the window and get
///         it back on the desk. After the window anyone can release, so the deal runs without either side online.
///         Each item is paid at most once. The buyer can withdraw whatever is not held. No owner, no admin, no upgrade.
/// @dev    The contract proves who delivered what and when, and enforces the price and the window. It cannot judge
///         the work: that is the buyer's dispute.
contract BatchDesk {
    struct Desk {
        address buyer;
        address worker;
        uint96 price;
        uint32 window;
        uint256 balance; // funded and not held
        uint256 held; // delivered, inside the review window
    }

    struct Item {
        bytes32 workHash;
        uint64 deliveredAt;
        uint8 state; // 0 none, 1 delivered (held), 2 released, 3 disputed
    }

    IERC20 public immutable token;
    mapping(bytes32 => Desk) public desks;
    mapping(bytes32 => mapping(bytes32 => Item)) public items;

    event DeskOpened(bytes32 indexed desk, address indexed buyer, address indexed worker, uint256 price, uint32 window, bytes32 label);
    event Funded(bytes32 indexed desk, address indexed by, uint256 amount);
    event Delivered(bytes32 indexed desk, bytes32 indexed item, bytes32 workHash);
    event Released(bytes32 indexed desk, bytes32 indexed item, uint256 paid);
    event Disputed(bytes32 indexed desk, bytes32 indexed item);
    event Withdrawn(bytes32 indexed desk, uint256 amount);

    error NotBuyer();
    error NotWorker();
    error BadInput();
    error Empty();
    error WrongState();
    error WindowOpen();
    error WindowClosed();
    error TransferFailed();

    constructor(IERC20 _token) {
        token = _token;
    }

    function deskId(address buyer, address worker, bytes32 label) public pure returns (bytes32) {
        return keccak256(abi.encode(buyer, worker, label));
    }

    /// @notice Open a desk. Price and window are fixed for the desk's life; a new label opens a new deal.
    function open(address worker, uint96 price, uint32 window, bytes32 label) external returns (bytes32 id) {
        if (worker == address(0) || price == 0 || window == 0) revert BadInput();
        id = deskId(msg.sender, worker, label);
        Desk storage d = desks[id];
        if (d.buyer != address(0)) revert BadInput();
        d.buyer = msg.sender;
        d.worker = worker;
        d.price = price;
        d.window = window;
        emit DeskOpened(id, msg.sender, worker, price, window, label);
    }

    /// @notice Anyone can fund a desk (a lender can fund a buyer's batch).
    function fund(bytes32 id, uint256 amount) external {
        Desk storage d = desks[id];
        if (d.buyer == address(0) || amount == 0) revert BadInput();
        d.balance += amount;
        _pull(msg.sender, amount);
        emit Funded(id, msg.sender, amount);
    }

    /// @notice The worker commits one delivered item. Its price moves from the balance into the hold.
    function deliver(bytes32 id, bytes32 item, bytes32 workHash) external {
        Desk storage d = desks[id];
        if (msg.sender != d.worker) revert NotWorker();
        if (item == 0 || workHash == 0) revert BadInput();
        Item storage it = items[id][item];
        if (it.state != 0) revert WrongState();
        uint256 price = d.price;
        if (d.balance < price) revert Empty();
        d.balance -= price;
        d.held += price;
        it.workHash = workHash;
        it.deliveredAt = uint64(block.timestamp);
        it.state = 1;
        emit Delivered(id, item, workHash);
    }

    /// @notice Pay a held item to the worker: the buyer at any time, anyone once the review window has passed.
    function release(bytes32 id, bytes32 item) public {
        Desk storage d = desks[id];
        Item storage it = items[id][item];
        if (it.state != 1) revert WrongState();
        if (msg.sender != d.buyer && block.timestamp < uint256(it.deliveredAt) + d.window) revert WindowOpen();
        it.state = 2;
        uint256 price = d.price;
        d.held -= price;
        _send(d.worker, price);
        emit Released(id, item, price);
    }

    function releaseMany(bytes32 id, bytes32[] calldata list) external {
        for (uint256 i; i < list.length; ++i) release(id, list[i]);
    }

    /// @notice The buyer rejects a delivery inside the window; its price goes back on the desk.
    function dispute(bytes32 id, bytes32 item) external {
        Desk storage d = desks[id];
        if (msg.sender != d.buyer) revert NotBuyer();
        Item storage it = items[id][item];
        if (it.state != 1) revert WrongState();
        if (block.timestamp >= uint256(it.deliveredAt) + d.window) revert WindowClosed();
        it.state = 3;
        uint256 price = d.price;
        d.held -= price;
        d.balance += price;
        emit Disputed(id, item);
    }

    /// @notice The buyer takes back funds that are not held.
    function withdraw(bytes32 id, uint256 amount) external {
        Desk storage d = desks[id];
        if (msg.sender != d.buyer) revert NotBuyer();
        if (amount == 0 || amount > d.balance) revert BadInput();
        d.balance -= amount;
        _send(msg.sender, amount);
        emit Withdrawn(id, amount);
    }

    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _send(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}

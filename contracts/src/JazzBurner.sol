// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 { function balanceOf(address) external view returns (uint256); function approve(address, uint256) external returns (bool); function transfer(address, uint256) external returns (bool); }
interface IReceiptChain { function count() external view returns (uint64); function head() external view returns (bytes32); }

/// @title JazzBurner
/// @notice The city's burn share arrives here in USDG. Anyone can turn it into a burn: the call swaps at most `cap` USDG
///         for $JAZZ through the one allowed router, and every $JAZZ the contract holds goes to the dead address. Each burn
///         names the receipt chain's count and head at that moment, so a burn points at the work it came from. A per-call
///         cap and a cooldown bound what a bad swap price can cost; the caller sets the minimum out.
contract JazzBurner {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    IERC20 public immutable usdg;
    IERC20 public immutable jazz;
    IReceiptChain public immutable receipts;
    address public admin;
    address public router;
    uint256 public cap;
    uint256 public cooldown;
    uint256 public lastBurn;

    event Burned(address indexed caller, uint256 usdgIn, uint256 jazzBurned, uint64 receipts, bytes32 head);
    event Router(address router);
    event Limits(uint256 cap, uint256 cooldown);

    error NotAdmin();
    error TooSoon();
    error OverCap();
    error SwapFailed();
    error TooLittle();

    constructor(address _usdg, address _jazz, address _receipts, address _admin, address _router, uint256 _cap, uint256 _cooldown) {
        usdg = IERC20(_usdg); jazz = IERC20(_jazz); receipts = IReceiptChain(_receipts);
        admin = _admin; router = _router; cap = _cap; cooldown = _cooldown;
        emit Router(_router); emit Limits(_cap, _cooldown);
    }

    /// @dev The router changes once, at graduation (curve → pool); the limits are the admin's to tune.
    function setRouter(address r) external { if (msg.sender != admin) revert NotAdmin(); router = r; emit Router(r); }
    function setLimits(uint256 c, uint256 cd) external { if (msg.sender != admin) revert NotAdmin(); cap = c; cooldown = cd; emit Limits(c, cd); }

    /// @param usdgIn USDG (6 decimals) to swap, at most `cap`. @param minOut the least $JAZZ the swap must produce.
    /// @param swap calldata for `router`, which must spend at most usdgIn of this contract's USDG and send $JAZZ here.
    function burn(uint256 usdgIn, uint256 minOut, bytes calldata swap) external returns (uint256 burned) {
        if (block.timestamp < lastBurn + cooldown) revert TooSoon();
        if (usdgIn > cap) revert OverCap();
        lastBurn = block.timestamp;
        uint256 before = jazz.balanceOf(address(this));
        uint256 usdgBefore = usdg.balanceOf(address(this));
        if (usdgIn > 0) {
            usdg.approve(router, usdgIn);
            (bool ok, ) = router.call(swap);
            if (!ok) revert SwapFailed();
            usdg.approve(router, 0);
            if (usdgBefore - usdg.balanceOf(address(this)) > usdgIn) revert OverCap();
            if (jazz.balanceOf(address(this)) - before < minOut) revert TooLittle();
        }
        burned = jazz.balanceOf(address(this));
        if (burned > 0) jazz.transfer(DEAD, burned);
        emit Burned(msg.sender, usdgIn, burned, receipts.count(), receipts.head());
    }
}

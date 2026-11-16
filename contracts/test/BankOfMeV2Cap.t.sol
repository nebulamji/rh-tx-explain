// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Reproduces the "vault cap" claim of the Bank of Me v2 audit on a Robinhood Chain mainnet fork:
// open lines can never exceed the vault's cash, and a withdraw that would leave lines uncovered reverts.
// Run: forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract BankOfMeV2Cap -vv
interface IBankV2 {
    function setLine(uint256 agentId, uint256 limit) external;
    function withdraw(address to, uint256 amount) external;
    function cash() external view returns (uint256);
    function totalLimits() external view returns (uint256);
    function owner() external view returns (address);
}
interface Vm { function prank(address) external; function expectRevert(bytes calldata) external; }

contract BankOfMeV2Cap {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IBankV2 constant BANK = IBankV2(0x9fB39e4338ceacf54E3918477293396e1300e96F);

    function test_linesNeverExceedCash() public {
        if (block.chainid != 4663) return;
        address owner = BANK.owner();
        uint256 cash = BANK.cash();
        vm.prank(owner);
        vm.expectRevert(bytes("lines exceed cash"));
        BANK.setLine(8811, cash + 1);
    }

    function test_withdrawCannotUncoverLines() public {
        if (block.chainid != 4663) return;
        address owner = BANK.owner();
        uint256 spare = BANK.cash() - BANK.totalLimits();
        vm.prank(owner);
        vm.expectRevert(bytes("would leave lines uncovered"));
        BANK.withdraw(owner, spare + 1);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CentralBank} from "../../src/CentralBank.sol";
import {CommercialBank} from "../../src/CommercialBank.sol";
import {DepositToken} from "../../src/DepositToken.sol";
import {SettlementEngine} from "../../src/SettlementEngine.sol";
import {WCBDC} from "../../src/WCBDC.sol";
import {SettlementHandler} from "./handlers/SettlementHandler.sol";

/// @notice CLAUDE.md invariant suite (Phase 2 scope: INVARIANTS 1, 2, 4, 5, 7).
///         The fuzzer drives random bounded payments and freezes through the handler;
///         these properties must hold after every call sequence.
contract InvariantsTest is Test {
    // Genesis constants — see CLAUDE.md "Constants"
    uint256 internal constant M0_TOTAL = 1_000_000e6;
    uint256 internal constant CBDC_PER_BANK = 500_000e6;
    uint256 internal constant DEP_CLIENT_1 = 2_400_000e6;
    uint256 internal constant DEP_CLIENT_2 = 1_600_000e6;
    uint256 internal constant M1_TOTAL = 8_000_000e6;
    // The documented genesis balance-sheet line: deposits - reserves = "loans".
    uint256 internal constant LOANS_PER_BANK = 3_500_000e6;

    CentralBank internal centralBank;
    CommercialBank internal bankA;
    CommercialBank internal bankB;
    DepositToken internal depA;
    DepositToken internal depB;
    SettlementEngine internal engine;
    WCBDC internal wcbdc;
    SettlementHandler internal handler;

    address internal cbOperator = makeAddr("centralBankOperator");
    address internal opA = makeAddr("bankAOperator");
    address internal opB = makeAddr("bankBOperator");
    address internal alice1 = makeAddr("alice1");
    address internal alice2 = makeAddr("alice2");
    address internal bob1 = makeAddr("bob1");
    address internal bob2 = makeAddr("bob2");

    function setUp() public {
        centralBank = new CentralBank(cbOperator);
        wcbdc = centralBank.wcbdc();
        bankA = new CommercialBank(opA, centralBank, "Bank A Deposit", "DEP-A");
        bankB = new CommercialBank(opB, centralBank, "Bank B Deposit", "DEP-B");
        depA = bankA.depositToken();
        depB = bankB.depositToken();
        engine = new SettlementEngine(centralBank);

        vm.startPrank(cbOperator);
        centralBank.registerBank(address(bankA));
        centralBank.registerBank(address(bankB));
        centralBank.mintCBDC(address(bankA), CBDC_PER_BANK);
        centralBank.mintCBDC(address(bankB), CBDC_PER_BANK);
        centralBank.setSettlementEngine(address(engine));
        vm.stopPrank();

        vm.startPrank(opA);
        bankA.setSettlementEngine(address(engine));
        bankA.registerClient(alice1);
        bankA.registerClient(alice2);
        bankA.creditClient(alice1, DEP_CLIENT_1);
        bankA.creditClient(alice2, DEP_CLIENT_2);
        vm.stopPrank();

        vm.startPrank(opB);
        bankB.setSettlementEngine(address(engine));
        bankB.registerClient(bob1);
        bankB.registerClient(bob2);
        bankB.creditClient(bob1, DEP_CLIENT_1);
        bankB.creditClient(bob2, DEP_CLIENT_2);
        vm.stopPrank();

        handler = new SettlementHandler(engine, [bankA, bankB], [opA, opB], [[alice1, alice2], [bob1, bob2]]);
        targetContract(address(handler));
    }

    /// @notice INVARIANT 1: M0 is constant in V1 — wCBDC only circulates after genesis.
    function invariant_M0SupplyConstant() public view {
        assertEq(wcbdc.totalSupply(), M0_TOTAL);
    }

    /// @notice INVARIANT 4: only the two allowlisted bank contracts ever hold wCBDC.
    function invariant_OnlyBanksHoldM0() public view {
        assertEq(wcbdc.balanceOf(address(bankA)) + wcbdc.balanceOf(address(bankB)), wcbdc.totalSupply());
    }

    /// @notice INVARIANT 7 (aggregate): payments conserve aggregate M1.
    /// @dev Test-suite invariant, NOT a system invariant: it holds only because the
    ///      handler never calls `creditClient`. The system deliberately allows M1 growth
    ///      through operator credit ("loans make deposits", picked up again in V3).
    function invariant_M1AggregateConstant() public view {
        assertEq(depA.totalSupply() + depB.totalSupply(), M1_TOTAL);
    }

    /// @notice INVARIANT 5: only registered clients hold a bank's deposits — the fixed
    ///         client universe accounts for the entire supply of each token.
    function invariant_OnlyClientsHoldDEP() public view {
        assertEq(depA.balanceOf(alice1) + depA.balanceOf(alice2), depA.totalSupply());
        assertEq(depB.balanceOf(bob1) + depB.balanceOf(bob2), depB.totalSupply());
    }

    /// @notice INVARIANT 2 (aggregate form): no M1 crosses banks without an equal M0
    ///         movement in the same transaction — so each bank's deposits and reserves
    ///         move in lockstep, pinning `deposits - reserves` to the genesis "loans"
    ///         balance-sheet line forever.
    function invariant_SettlementCoupling() public view {
        assertEq(depA.totalSupply() - bankA.reserves(), LOANS_PER_BANK);
        assertEq(depB.totalSupply() - bankB.reserves(), LOANS_PER_BANK);
    }
}

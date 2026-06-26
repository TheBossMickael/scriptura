// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CentralBank} from "../../src/CentralBank.sol";
import {CommercialBank} from "../../src/CommercialBank.sol";
import {DepositToken} from "../../src/DepositToken.sol";
import {SettlementEngine} from "../../src/SettlementEngine.sol";
import {StableCo} from "../../src/StableCo.sol";
import {StableEUR} from "../../src/StableEUR.sol";
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
    StableCo internal stableCo;
    StableEUR internal seur;
    WCBDC internal wcbdc;
    SettlementHandler internal handler;

    address internal cbOperator = makeAddr("centralBankOperator");
    address internal opA = makeAddr("bankAOperator");
    address internal opB = makeAddr("bankBOperator");
    address internal scOperator = makeAddr("stableCoOperator");

    // Clients sign EIP-712 intents in the handler, so they carry real keys.
    address internal alice1;
    uint256 internal alice1Key;
    address internal alice2;
    uint256 internal alice2Key;
    address internal bob1;
    uint256 internal bob1Key;
    address internal bob2;
    uint256 internal bob2Key;

    function setUp() public {
        (alice1, alice1Key) = makeAddrAndKey("alice1");
        (alice2, alice2Key) = makeAddrAndKey("alice2");
        (bob1, bob1Key) = makeAddrAndKey("bob1");
        (bob2, bob2Key) = makeAddrAndKey("bob2");

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

        // Stablecoin layer wired before the handler so its mint/redeem actions are live.
        vm.prank(scOperator);
        stableCo = new StableCo(engine, bankA, scOperator);
        seur = stableCo.seur();
        vm.prank(cbOperator);
        engine.setStableCo(address(stableCo));
        vm.prank(opA);
        bankA.registerClient(address(stableCo));

        handler = new SettlementHandler(
            engine,
            [bankA, bankB],
            [opA, opB],
            [
                [
                    SettlementHandler.ClientAccount(alice1, alice1Key),
                    SettlementHandler.ClientAccount(alice2, alice2Key)
                ],
                [SettlementHandler.ClientAccount(bob1, bob1Key), SettlementHandler.ClientAccount(bob2, bob2Key)]
            ],
            stableCo
        );
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
    ///         client universe accounts for the entire supply of each token. StableCo is a
    ///         registered client of Bank A, so it holds the DEP-A reserves backing sEUR.
    function invariant_OnlyClientsHoldDEP() public view {
        assertEq(
            depA.balanceOf(alice1) + depA.balanceOf(alice2) + depA.balanceOf(address(stableCo)), depA.totalSupply()
        );
        assertEq(depB.balanceOf(bob1) + depB.balanceOf(bob2), depB.totalSupply());
    }

    /// @notice INVARIANT 3: sEUR is always 100% covered — its supply never exceeds the
    ///         vault's DEP-A reserves. The coverage-safe ordering of mint (reserves in
    ///         before issuance) and redeem (burn before reserves out) keeps this holding
    ///         through every same-bank and cross-bank flow.
    function invariant_StableCoverage() public view {
        assertLe(seur.totalSupply(), depA.balanceOf(address(stableCo)));
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

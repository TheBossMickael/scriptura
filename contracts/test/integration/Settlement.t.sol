// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CentralBank} from "../../src/CentralBank.sol";
import {CommercialBank} from "../../src/CommercialBank.sol";
import {DepositToken} from "../../src/DepositToken.sol";
import {SettlementEngine} from "../../src/SettlementEngine.sol";
import {WCBDC} from "../../src/WCBDC.sol";

/// @notice End-to-end settlement flows on a full genesis-state system: intrabank,
///         interbank, ratio breach (soft), illiquidity (hard), freeze, conservation.
///         Every payment travels the production path: client-signed EIP-712 intent,
///         submitted by a relayer EOA distinct from the payer.
contract SettlementIntegrationTest is Test {
    // Genesis constants — see CLAUDE.md "Constants" (recalibrated 2026-06-10)
    uint256 internal constant CBDC_PER_BANK = 500_000e6; // 1_000_000e6 total M0
    uint256 internal constant DEP_CLIENT_1 = 2_400_000e6; // alice1 / bob1
    uint256 internal constant DEP_CLIENT_2 = 1_600_000e6; // alice2 / bob2
    uint256 internal constant DEP_PER_BANK = 4_000_000e6;

    CentralBank internal centralBank;
    CommercialBank internal bankA;
    CommercialBank internal bankB;
    DepositToken internal depA;
    DepositToken internal depB;
    SettlementEngine internal engine;
    WCBDC internal wcbdc;

    address internal cbOperator = makeAddr("centralBankOperator");
    address internal opA = makeAddr("bankAOperator");
    address internal opB = makeAddr("bankBOperator");
    address internal relayer = makeAddr("relayer");

    address internal alice1;
    address internal alice2;
    address internal bob1;
    address internal bob2;

    /// @dev Client signing keys, looked up by address when a payment is built.
    mapping(address client => uint256 key) internal signingKey;

    function setUp() public {
        uint256 key;
        (alice1, key) = makeAddrAndKey("alice1");
        signingKey[alice1] = key;
        (alice2, key) = makeAddrAndKey("alice2");
        signingKey[alice2] = key;
        (bob1, key) = makeAddrAndKey("bob1");
        signingKey[bob1] = key;
        (bob2, key) = makeAddrAndKey("bob2");
        signingKey[bob2] = key;

        // Mirrors the genesis script: M0 issuance, bank wiring, client onboarding,
        // deposit creation. Initial ratio 12.5% per bank, threshold 10%.
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
    }

    /// @dev Builds and signs an EIP-712 intent for `from` (current nonce, 1h deadline).
    ///      Kept separate from `_submit` because expectRevert/expectEmit bind to the NEXT
    ///      external call — the view calls made here must happen before the cheatcode.
    function _signed(address from, CommercialBank fromBank, CommercialBank toBank, address to, uint256 amount)
        internal
        view
        returns (SettlementEngine.PaymentIntent memory intent, bytes memory signature)
    {
        intent = SettlementEngine.PaymentIntent({
            from: from,
            fromBank: address(fromBank),
            toBank: address(toBank),
            to: to,
            amount: amount,
            nonce: engine.nonces(from),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signingKey[from], engine.hashIntent(intent));
        signature = abi.encodePacked(r, s, v);
    }

    /// @dev Submits a signed intent as the relayer — never the payer (production path).
    function _submit(SettlementEngine.PaymentIntent memory intent, bytes memory signature) internal {
        vm.prank(relayer);
        engine.executeIntent(intent, signature);
    }

    /// @dev Full gasless payment: sign then relay.
    function _pay(address from, CommercialBank fromBank, CommercialBank toBank, address to, uint256 amount) internal {
        (SettlementEngine.PaymentIntent memory intent, bytes memory signature) =
            _signed(from, fromBank, toBank, to, amount);
        _submit(intent, signature);
    }

    /*//////////////////////////////////////////////////////////////
                                GENESIS
    //////////////////////////////////////////////////////////////*/

    function test_Genesis_StateIsConsistent() public view {
        assertEq(wcbdc.totalSupply(), 1_000_000e6); // INVARIANT 1
        assertEq(bankA.reserves(), CBDC_PER_BANK);
        assertEq(bankB.reserves(), CBDC_PER_BANK);
        assertEq(depA.totalSupply(), DEP_PER_BANK);
        assertEq(depB.totalSupply(), DEP_PER_BANK);
        assertEq(bankA.reserveRatioBps(), 1_250); // 12.5%, above the 10% threshold
        assertEq(bankB.reserveRatioBps(), 1_250);
    }

    /*//////////////////////////////////////////////////////////////
                          INTRABANK PAYMENT
    //////////////////////////////////////////////////////////////*/

    function test_IntrabankPayment_MovesDepositsOnly() public {
        _pay(alice1, bankA, bankA, alice2, 200_000e6);

        assertEq(depA.balanceOf(alice1), 2_200_000e6);
        assertEq(depA.balanceOf(alice2), 1_800_000e6);
        // No settlement happened: M1 supply, reserves and ratio are all untouched.
        assertEq(depA.totalSupply(), DEP_PER_BANK);
        assertEq(bankA.reserves(), CBDC_PER_BANK);
        assertEq(bankA.reserveRatioBps(), 1_250);
        assertEq(wcbdc.totalSupply(), 1_000_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                          INTERBANK PAYMENT
    //////////////////////////////////////////////////////////////*/

    function test_InterbankPayment_SettlesInCentralBankMoney() public {
        (SettlementEngine.PaymentIntent memory intent, bytes memory signature) =
            _signed(alice1, bankA, bankB, bob1, 100_000e6);

        vm.expectEmit(true, true, true, true, address(engine));
        emit SettlementEngine.Settled(alice1, address(bankA), address(bankB), bob1, 100_000e6);
        _submit(intent, signature);

        // INVARIANT 2/7: equal burn, wCBDC move and mint, one transaction.
        assertEq(depA.balanceOf(alice1), 2_300_000e6);
        assertEq(depA.totalSupply(), 3_900_000e6);
        assertEq(bankA.reserves(), 400_000e6);
        assertEq(bankB.reserves(), 600_000e6);
        assertEq(depB.balanceOf(bob1), 2_500_000e6);
        assertEq(depB.totalSupply(), 4_100_000e6);
        assertEq(wcbdc.totalSupply(), 1_000_000e6); // M0 circulates, never created

        // The payer's intent nonce advanced — the relayer paid gas, alice1 paid deposits.
        assertEq(engine.nonces(alice1), 1);

        // Payer's ratio degrades (still healthy), receiver's mechanically improves.
        assertEq(bankA.reserveRatioBps(), 1_025); // 400_000 / 3_900_000
        assertEq(bankB.reserveRatioBps(), 1_463); // 600_000 / 4_100_000
    }

    function test_InterbankPayment_BreachesRatioAndStillSettles() public {
        // 350_000 / 3_850_000 = 9.09% < 10%: the paying bank flags itself STRESSED but
        // keeps paying — the ratio is monitored, never enforced per transaction (trap #4).
        (SettlementEngine.PaymentIntent memory intent, bytes memory signature) =
            _signed(alice1, bankA, bankB, bob1, 150_000e6);

        vm.expectEmit(true, false, false, true, address(bankA));
        emit CommercialBank.ReserveRatioBreached(address(bankA), 909, 1_000);
        _submit(intent, signature);

        assertEq(depB.balanceOf(bob1), 2_550_000e6); // settled despite the breach
        assertEq(bankA.reserves(), 350_000e6);
        assertLt(bankA.reserveRatioBps(), centralBank.reserveRatioThresholdBps());
    }

    function test_RevertWhen_BankIlliquid_IntrabankStillWorks() public {
        // Drain bank A's reserves entirely: 500_000 of outgoing settlements.
        _pay(alice1, bankA, bankB, bob1, 500_000e6);
        assertEq(bankA.reserves(), 0);

        // ILLIQUID: the next interbank payment hits the hard physical constraint…
        (SettlementEngine.PaymentIntent memory intent, bytes memory signature) =
            _signed(alice2, bankA, bankB, bob2, 1e6);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InsufficientReserves.selector, address(bankA), 1e6, 0));
        _submit(intent, signature);

        // …but illiquid is not frozen: intrabank book transfers need no reserves.
        _pay(alice2, bankA, bankA, alice1, 100_000e6);
        assertEq(depA.balanceOf(alice2), 1_500_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                            FREEZE / UNFREEZE
    //////////////////////////////////////////////////////////////*/

    function test_Freeze_BlocksAllDepositMovementBothDirections() public {
        vm.expectEmit(false, false, false, false, address(bankA));
        emit CommercialBank.BankFrozen();
        vm.prank(opA);
        bankA.freeze();

        SettlementEngine.PaymentIntent memory intent;
        bytes memory signature;

        // Intrabank at the frozen bank: blocked.
        (intent, signature) = _signed(alice1, bankA, bankA, alice2, 1e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _submit(intent, signature);

        // Outgoing interbank: blocked (the DEP-A burn is paused).
        (intent, signature) = _signed(alice1, bankA, bankB, bob1, 1e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _submit(intent, signature);

        // Incoming interbank: blocked too (the DEP-A mint is paused) — money cannot
        // enter a frozen bank either.
        (intent, signature) = _signed(bob1, bankB, bankA, alice1, 1e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _submit(intent, signature);

        // A reverted intent consumes nothing: the whole tx rolled back, nonces included,
        // so the same signed intents could be resubmitted after the unfreeze.
        assertEq(engine.nonces(alice1), 0);
        assertEq(engine.nonces(bob1), 0);

        // Bank B is unaffected: the freeze is strictly local to A.
        _pay(bob1, bankB, bankB, bob2, 50_000e6);
        assertEq(depB.balanceOf(bob2), 1_650_000e6);
    }

    function test_Unfreeze_ResumesSettlement() public {
        vm.prank(opA);
        bankA.freeze();

        vm.expectEmit(false, false, false, false, address(bankA));
        emit CommercialBank.BankUnfrozen();
        vm.prank(opA);
        bankA.unfreeze();

        _pay(alice1, bankA, bankB, bob1, 100_000e6);
        assertEq(depB.balanceOf(bob1), 2_500_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                             CONSERVATION
    //////////////////////////////////////////////////////////////*/

    function test_RoundTrip_RestoresGenesisState() public {
        // A->B then B->A of the same amount: every aggregate returns to genesis values —
        // settlement moves value around, it never creates or destroys any (INVARIANT 7).
        _pay(alice1, bankA, bankB, bob1, 150_000e6);
        _pay(bob1, bankB, bankA, alice1, 150_000e6);

        assertEq(depA.balanceOf(alice1), DEP_CLIENT_1);
        assertEq(depB.balanceOf(bob1), DEP_CLIENT_1);
        assertEq(depA.totalSupply(), DEP_PER_BANK);
        assertEq(depB.totalSupply(), DEP_PER_BANK);
        assertEq(bankA.reserves(), CBDC_PER_BANK);
        assertEq(bankB.reserves(), CBDC_PER_BANK);
        assertEq(bankA.reserveRatioBps(), 1_250);
        assertEq(bankB.reserveRatioBps(), 1_250);
        assertEq(wcbdc.totalSupply(), 1_000_000e6);
    }
}

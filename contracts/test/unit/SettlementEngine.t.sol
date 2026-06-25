// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CentralBank} from "../../src/CentralBank.sol";
import {CommercialBank} from "../../src/CommercialBank.sol";
import {DepositToken} from "../../src/DepositToken.sol";
import {SettlementEngine} from "../../src/SettlementEngine.sol";
import {WCBDC} from "../../src/WCBDC.sol";

contract SettlementEngineTest is Test {
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

    // Clients sign intents, so they need real keys (not just addresses).
    address internal alice1;
    uint256 internal alice1Key;
    address internal alice2;
    uint256 internal alice2Key;
    address internal bob1;
    uint256 internal bob1Key;
    address internal stranger;
    uint256 internal strangerKey;

    bytes32 internal constant BREACH_TOPIC = keccak256("ReserveRatioBreached(address,uint256,uint256)");
    bytes32 internal constant SETTLED_TOPIC = keccak256("Settled(address,address,address,address,uint256)");

    function setUp() public {
        (alice1, alice1Key) = makeAddrAndKey("alice1");
        (alice2, alice2Key) = makeAddrAndKey("alice2");
        (bob1, bob1Key) = makeAddrAndKey("bob1");
        (stranger, strangerKey) = makeAddrAndKey("stranger");

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
        centralBank.mintCBDC(address(bankA), 1_000e6);
        centralBank.mintCBDC(address(bankB), 1_000e6);
        centralBank.setSettlementEngine(address(engine));
        vm.stopPrank();

        // Both banks at 12.5% ratio (1_000 reserves / 8_000 deposits), threshold 10%.
        vm.startPrank(opA);
        bankA.setSettlementEngine(address(engine));
        bankA.registerClient(alice1);
        bankA.registerClient(alice2);
        bankA.creditClient(alice1, 5_000e6);
        bankA.creditClient(alice2, 3_000e6);
        vm.stopPrank();

        vm.startPrank(opB);
        bankB.setSettlementEngine(address(engine));
        bankB.registerClient(bob1);
        bankB.creditClient(bob1, 8_000e6);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                            INTENT HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Builds an intent with the payer's current sequential nonce and a 1h deadline.
    function _intent(address from, address fromBank, address toBank, address to, uint256 amount)
        internal
        view
        returns (SettlementEngine.PaymentIntent memory)
    {
        return SettlementEngine.PaymentIntent({
            from: from,
            fromBank: fromBank,
            toBank: toBank,
            to: to,
            amount: amount,
            nonce: engine.nonces(from),
            deadline: block.timestamp + 1 hours
        });
    }

    function _sign(uint256 key, SettlementEngine.PaymentIntent memory intent) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, engine.hashIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Signs with `key` and submits as the relayer — the standard gasless path.
    function _execute(uint256 key, SettlementEngine.PaymentIntent memory intent) internal {
        bytes memory signature = _sign(key, intent);
        vm.prank(relayer);
        engine.executeIntent(intent, signature);
    }

    /// @dev Counts entries with the given event topic among recorded logs.
    function _logCount(bytes32 topic) internal returns (uint256 count) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) count++;
        }
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_WiresCentralBankAndWCBDC() public view {
        assertEq(address(engine.centralBank()), address(centralBank));
        assertEq(address(engine.wcbdc()), address(wcbdc));
        assertTrue(wcbdc.hasRole(wcbdc.SETTLER_ROLE(), address(engine)));
    }

    function test_Nonces_StartAtZero() public view {
        assertEq(engine.nonces(alice1), 0);
        assertEq(engine.nonces(bob1), 0);
    }

    /*//////////////////////////////////////////////////////////////
                          INTENT VERIFICATION
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_IntentExpired() public {
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);
        intent.deadline = block.timestamp - 1;
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.IntentExpired.selector, intent.deadline));
        engine.executeIntent(intent, signature);
    }

    function test_DeadlineIsInclusive() public {
        // ERC20Permit semantics: an intent executed exactly at its deadline is valid.
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);
        intent.deadline = block.timestamp;
        _executeRaw(alice1Key, intent);
        assertEq(depB.balanceOf(bob1), 8_100e6);
    }

    function test_RevertWhen_WrongSigner() public {
        // alice2 signs an intent debiting alice1: recovery yields alice2, not the payer.
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);
        bytes memory signature = _sign(alice2Key, intent);

        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InvalidIntentSigner.selector, alice2, alice1));
        engine.executeIntent(intent, signature);
    }

    function test_RevertWhen_TamperedAmount() public {
        // A valid signature over a different amount recovers to some unrelated address.
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);
        bytes memory signature = _sign(alice1Key, intent);
        intent.amount = 5_000e6;

        vm.expectPartialRevert(SettlementEngine.InvalidIntentSigner.selector);
        engine.executeIntent(intent, signature);
    }

    function test_RevertWhen_NonceReplayed() public {
        // INVARIANT 6: a consumed intent can never be replayed, even with a valid signature.
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);
        bytes memory signature = _sign(alice1Key, intent);
        engine.executeIntent(intent, signature);

        vm.expectRevert(abi.encodeWithSelector(Nonces.InvalidAccountNonce.selector, alice1, 1));
        engine.executeIntent(intent, signature);
    }

    function test_RevertWhen_NonceGap() public {
        // Sequential nonces: signing a future nonce is not enough, order is enforced.
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);
        intent.nonce = 5;
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectRevert(abi.encodeWithSelector(Nonces.InvalidAccountNonce.selector, alice1, 0));
        engine.executeIntent(intent, signature);
    }

    function test_SequentialNoncesAdvance() public {
        _execute(alice1Key, _intent(alice1, address(bankA), address(bankB), bob1, 100e6));
        _execute(alice1Key, _intent(alice1, address(bankA), address(bankA), alice2, 50e6));
        assertEq(engine.nonces(alice1), 2);
        assertEq(engine.nonces(bob1), 0); // nonces are strictly per payer
    }

    function test_AnyAddressCanRelay() public {
        // Relay-agnostic by design: the signature is the authorization, the submitter is
        // irrelevant (censorship is operational, not contractual; self-relay possible).
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);
        bytes memory signature = _sign(alice1Key, intent);

        vm.prank(stranger);
        engine.executeIntent(intent, signature);
        assertEq(depB.balanceOf(bob1), 8_100e6);
    }

    function test_Emits_IntentExecuted() public {
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);
        bytes memory signature = _sign(alice1Key, intent);
        // Computed before expectEmit: the cheatcode binds to the NEXT external call, and
        // hashIntent is itself an external (view) call.
        bytes32 digest = engine.hashIntent(intent);

        vm.expectEmit(true, true, false, true, address(engine));
        emit SettlementEngine.IntentExecuted(digest, alice1, 0);
        engine.executeIntent(intent, signature);
    }

    function test_HashIntent_MatchesEIP712Digest() public view {
        // Recomputes the digest from scratch (domain separator included): the relayer and
        // frontend must be able to reproduce hashIntent exactly off-chain.
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("SettlementEngine")),
                keccak256(bytes("1")),
                block.chainid,
                address(engine)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                engine.PAYMENT_INTENT_TYPEHASH(),
                intent.from,
                intent.fromBank,
                intent.toBank,
                intent.to,
                intent.amount,
                intent.nonce,
                intent.deadline
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        assertEq(engine.hashIntent(intent), expected);
    }

    /*//////////////////////////////////////////////////////////////
                               VALIDATION
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_ZeroAmount() public {
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 0);
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectRevert(SettlementEngine.ZeroAmount.selector);
        engine.executeIntent(intent, signature);
    }

    function test_RevertWhen_FromBankNotRegistered() public {
        address fakeBank = makeAddr("fakeBank");
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, fakeBank, address(bankB), bob1, 1e6);
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotRegisteredBank.selector, fakeBank));
        engine.executeIntent(intent, signature);
    }

    function test_RevertWhen_ToBankNotRegistered() public {
        address fakeBank = makeAddr("fakeBank");
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), fakeBank, bob1, 1e6);
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotRegisteredBank.selector, fakeBank));
        engine.executeIntent(intent, signature);
    }

    function test_RevertWhen_PayerNotClient() public {
        SettlementEngine.PaymentIntent memory intent = _intent(stranger, address(bankA), address(bankB), bob1, 1e6);
        bytes memory signature = _sign(strangerKey, intent);

        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotBankClient.selector, address(bankA), stranger));
        engine.executeIntent(intent, signature);
    }

    function test_RevertWhen_PayeeNotClient() public {
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), stranger, 1e6);
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotBankClient.selector, address(bankB), stranger));
        engine.executeIntent(intent, signature);
    }

    function test_RevertWhen_FrozenBank() public {
        vm.prank(opA);
        bankA.freeze();

        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankA), alice2, 1e6);
        bytes memory signature = _sign(alice1Key, intent);

        // The nonce IS consumed before the paused token reverts the whole transaction —
        // atomicity rolls everything back together, so no nonce is burned by a failed tx.
        vm.expectRevert(Pausable.EnforcedPause.selector);
        engine.executeIntent(intent, signature);
        assertEq(engine.nonces(alice1), 0);
    }

    /*//////////////////////////////////////////////////////////////
                               INTRABANK
    //////////////////////////////////////////////////////////////*/

    function test_Intrabank_TransfersDepositsWithoutWCBDC() public {
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankA), alice2, 700e6);
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectEmit(true, true, true, true, address(engine));
        emit SettlementEngine.IntrabankTransfer(address(bankA), alice1, alice2, 700e6);
        vm.prank(relayer);
        engine.executeIntent(intent, signature);

        assertEq(depA.balanceOf(alice1), 4_300e6);
        assertEq(depA.balanceOf(alice2), 3_700e6);
        assertEq(depA.totalSupply(), 8_000e6); // book transfer: M1 supply untouched
        assertEq(wcbdc.balanceOf(address(bankA)), 1_000e6); // no central bank money moved
        assertEq(wcbdc.balanceOf(address(bankB)), 1_000e6);
    }

    function test_Intrabank_EmitsNoSettledEvent() public {
        vm.recordLogs();
        _execute(alice1Key, _intent(alice1, address(bankA), address(bankA), alice2, 100e6));
        assertEq(_logCount(SETTLED_TOPIC), 0);
    }

    function test_RevertWhen_IntrabankInsufficientBalance() public {
        // No reserve pre-check on the intrabank path: only the payer's DEP balance binds.
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankA), alice2, 6_000e6);
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice1, 5_000e6, 6_000e6)
        );
        engine.executeIntent(intent, signature);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERBANK
    //////////////////////////////////////////////////////////////*/

    function test_Interbank_SettlesAtomically() public {
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 100e6);
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectEmit(true, true, true, true, address(engine));
        emit SettlementEngine.Settled(alice1, address(bankA), address(bankB), bob1, 100e6);
        vm.prank(relayer);
        engine.executeIntent(intent, signature);

        // INVARIANT 7: burn(DEP-A) == wCBDC moved == mint(DEP-B), all in one tx.
        assertEq(depA.balanceOf(alice1), 4_900e6);
        assertEq(depA.totalSupply(), 7_900e6);
        assertEq(wcbdc.balanceOf(address(bankA)), 900e6);
        assertEq(wcbdc.balanceOf(address(bankB)), 1_100e6);
        assertEq(depB.balanceOf(bob1), 8_100e6);
        assertEq(depB.totalSupply(), 8_100e6);
        assertEq(wcbdc.totalSupply(), 2_000e6); // M0 circulates, never created
    }

    function test_Interbank_NoBreachAboveThreshold() public {
        vm.recordLogs();
        _execute(alice1Key, _intent(alice1, address(bankA), address(bankB), bob1, 100e6)); // 900/7_900 = 11.39%
        assertEq(_logCount(BREACH_TOPIC), 0);
    }

    function test_Interbank_EmitsBreachAndStillSettles() public {
        // 700 reserves / 7_700 deposits = 9.09% < 10% threshold. The breach is emitted by
        // the paying BANK contract (factored check), and the payment still settles: the
        // ratio is a soft, monitored constraint, never a per-transaction gate (trap #4).
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 300e6);
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectEmit(true, false, false, true, address(bankA));
        emit CommercialBank.ReserveRatioBreached(address(bankA), 909, 1_000);
        engine.executeIntent(intent, signature);

        assertEq(depB.balanceOf(bob1), 8_300e6); // settled despite the breach
        assertEq(wcbdc.balanceOf(address(bankA)), 700e6);
    }

    function test_RevertWhen_InsufficientReserves() public {
        // alice1 holds 5_000 DEP-A but bank A only holds 1_000 wCBDC: the hard physical
        // constraint binds (ILLIQUID state) even though the client balance suffices.
        SettlementEngine.PaymentIntent memory intent = _intent(alice1, address(bankA), address(bankB), bob1, 2_000e6);
        bytes memory signature = _sign(alice1Key, intent);

        vm.expectRevert(
            abi.encodeWithSelector(SettlementEngine.InsufficientReserves.selector, address(bankA), 2_000e6, 1_000e6)
        );
        engine.executeIntent(intent, signature);
    }

    /*//////////////////////////////////////////////////////////////
                                MISC
    //////////////////////////////////////////////////////////////*/

    /// @dev Variant of `_execute` without the relayer prank, for tests that already
    ///      prank or need the default sender.
    function _executeRaw(uint256 key, SettlementEngine.PaymentIntent memory intent) internal {
        bytes memory signature = _sign(key, intent);
        engine.executeIntent(intent, signature);
    }
}

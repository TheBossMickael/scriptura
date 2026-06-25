// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {CommercialBank} from "../../../src/CommercialBank.sol";
import {SettlementEngine} from "../../../src/SettlementEngine.sol";
import {WCBDC} from "../../../src/WCBDC.sol";

/// @notice Invariant-fuzzing handler: drives the system through bounded, never-reverting
///         payment and freeze actions so the fuzzer explores deep call sequences with
///         `fail_on_revert = true`. Payments travel the production path: each one is an
///         EIP-712 intent signed with the payer's key and submitted by the handler itself
///         (the engine is relay-agnostic — any submitter works).
/// @dev Deliberately does NOT call `creditClient`: aggregate M1 growth is allowed by the
///      system (operator credit power), so freezing it here is what makes the test-suite
///      invariant `invariant_M1AggregateConstant` meaningful — payments alone must
///      conserve aggregate value.
contract SettlementHandler is CommonBase, StdCheats, StdUtils {
    /// @notice A client EOA able to sign intents.
    struct ClientAccount {
        address addr;
        uint256 key;
    }

    SettlementEngine internal immutable engine;
    WCBDC internal immutable wcbdc;

    CommercialBank[2] internal banks;
    address[2] internal operators;
    // clients[bankIndex][clientIndex] — fixed actor universe (alice1/2, bob1/2).
    ClientAccount[2][2] internal clients;

    constructor(
        SettlementEngine engine_,
        CommercialBank[2] memory banks_,
        address[2] memory operators_,
        ClientAccount[2][2] memory clients_
    ) {
        engine = engine_;
        wcbdc = engine_.wcbdc();
        banks = banks_;
        operators = operators_;
        // Element-wise: solc 0.8.24 (legacy codegen) cannot copy a struct array
        // memory->storage in one assignment.
        for (uint256 i = 0; i < 2; i++) {
            for (uint256 j = 0; j < 2; j++) {
                clients[i][j] = clients_[i][j];
            }
        }
    }

    /// @notice Payment between two clients of the same (random) bank.
    function payIntrabank(uint256 bankSeed, uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        uint256 b = bankSeed % 2;
        CommercialBank bank = banks[b];
        if (bank.depositToken().paused()) return;

        ClientAccount memory from = clients[b][fromSeed % 2];
        ClientAccount memory to = clients[b][toSeed % 2];
        amount = bound(amount, 0, bank.depositToken().balanceOf(from.addr));
        if (amount == 0) return;

        _executeSignedIntent(from, address(bank), address(bank), to.addr, amount);
    }

    /// @notice Payment across banks (random direction), capped by both the payer's
    ///         deposits and the paying bank's reserves (hard constraint).
    function payInterbank(uint256 dirSeed, uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        uint256 fromIdx = dirSeed % 2;
        uint256 toIdx = 1 - fromIdx;
        CommercialBank fromBank = banks[fromIdx];
        CommercialBank toBank = banks[toIdx];
        if (fromBank.depositToken().paused() || toBank.depositToken().paused()) return;

        ClientAccount memory from = clients[fromIdx][fromSeed % 2];
        ClientAccount memory to = clients[toIdx][toSeed % 2];
        uint256 cap = fromBank.depositToken().balanceOf(from.addr);
        uint256 bankReserves = wcbdc.balanceOf(address(fromBank));
        if (bankReserves < cap) cap = bankReserves;
        amount = bound(amount, 0, cap);
        if (amount == 0) return;

        _executeSignedIntent(from, address(fromBank), address(toBank), to.addr, amount);
    }

    /// @notice Operator freezes/unfreezes a random bank — settlements must keep
    ///         conserving value around frozen periods.
    function toggleFreeze(uint256 bankSeed) external {
        uint256 b = bankSeed % 2;
        CommercialBank bank = banks[b];
        // Read state BEFORE pranking: vm.prank applies to the next external call, and
        // the paused() view would consume it otherwise.
        bool frozen = bank.depositToken().paused();
        vm.prank(operators[b]);
        if (frozen) {
            bank.unfreeze();
        } else {
            bank.freeze();
        }
    }

    /// @dev Builds the intent with the payer's live sequential nonce, signs the EIP-712
    ///      digest with the payer's key, and submits in the handler's own name. Never
    ///      reverts for bounded inputs: nonce is fresh, deadline in the future, signature
    ///      valid, both parties registered, amounts capped by the callers.
    function _executeSignedIntent(
        ClientAccount memory from,
        address fromBank,
        address toBank,
        address to,
        uint256 amount
    ) internal {
        SettlementEngine.PaymentIntent memory intent = SettlementEngine.PaymentIntent({
            from: from.addr,
            fromBank: fromBank,
            toBank: toBank,
            to: to,
            amount: amount,
            nonce: engine.nonces(from.addr),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(from.key, engine.hashIntent(intent));
        engine.executeIntent(intent, abi.encodePacked(r, s, v));
    }
}

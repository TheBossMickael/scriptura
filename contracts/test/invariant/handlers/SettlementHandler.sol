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
///         `fail_on_revert = true`.
/// @dev Deliberately does NOT call `creditClient`: aggregate M1 growth is allowed by the
///      system (operator credit power), so freezing it here is what makes the test-suite
///      invariant `invariant_M1AggregateConstant` meaningful — payments alone must
///      conserve aggregate value.
contract SettlementHandler is CommonBase, StdCheats, StdUtils {
    SettlementEngine internal immutable engine;
    WCBDC internal immutable wcbdc;

    CommercialBank[2] internal banks;
    address[2] internal operators;
    // clients[bankIndex][clientIndex] — fixed actor universe (alice1/2, bob1/2).
    address[2][2] internal clients;

    constructor(
        SettlementEngine engine_,
        CommercialBank[2] memory banks_,
        address[2] memory operators_,
        address[2][2] memory clients_
    ) {
        engine = engine_;
        wcbdc = engine_.wcbdc();
        banks = banks_;
        operators = operators_;
        clients = clients_;
    }

    /// @notice Payment between two clients of the same (random) bank.
    function payIntrabank(uint256 bankSeed, uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        uint256 b = bankSeed % 2;
        CommercialBank bank = banks[b];
        if (bank.depositToken().paused()) return;

        address from = clients[b][fromSeed % 2];
        address to = clients[b][toSeed % 2];
        amount = bound(amount, 0, bank.depositToken().balanceOf(from));
        if (amount == 0) return;

        vm.prank(from);
        engine.settle(address(bank), address(bank), to, amount);
    }

    /// @notice Payment across banks (random direction), capped by both the payer's
    ///         deposits and the paying bank's reserves (hard constraint).
    function payInterbank(uint256 dirSeed, uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        uint256 fromIdx = dirSeed % 2;
        uint256 toIdx = 1 - fromIdx;
        CommercialBank fromBank = banks[fromIdx];
        CommercialBank toBank = banks[toIdx];
        if (fromBank.depositToken().paused() || toBank.depositToken().paused()) return;

        address from = clients[fromIdx][fromSeed % 2];
        address to = clients[toIdx][toSeed % 2];
        uint256 cap = fromBank.depositToken().balanceOf(from);
        uint256 bankReserves = wcbdc.balanceOf(address(fromBank));
        if (bankReserves < cap) cap = bankReserves;
        amount = bound(amount, 0, cap);
        if (amount == 0) return;

        vm.prank(from);
        engine.settle(address(fromBank), address(toBank), to, amount);
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
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CentralBank} from "./CentralBank.sol";
import {CommercialBank} from "./CommercialBank.sol";
import {WCBDC} from "./WCBDC.sol";

/// @title SettlementEngine — atomic interbank settlement in central bank money
/// @notice The system's core: routes a client payment either as an intrabank book
///         transfer (same bank, no wCBDC) or as an interbank settlement — burn the
///         payer's deposits, move wCBDC between bank reserves, mint deposits to the
///         payee — all within one transaction (INVARIANTS 2 and 7).
/// @dev Stateless and bank-agnostic: banks are validated against the CentralBank
///      registry per call, deposit tokens discovered via `CommercialBank.depositToken()`.
///      Phase 3 adds EIP-712 `PaymentIntent` verification (`executeIntent`) on top of
///      the same `_settle` core.
contract SettlementEngine {
    /// @notice The central bank, used as the registry of valid commercial banks.
    CentralBank public immutable centralBank;

    /// @notice The wCBDC token reserves are settled in.
    WCBDC public immutable wcbdc;

    event Settled(address indexed from, address indexed fromBank, address indexed toBank, address to, uint256 amount);
    event IntrabankTransfer(address indexed bank, address indexed from, address indexed to, uint256 amount);

    error ZeroAmount();
    error NotRegisteredBank(address bank);
    error NotBankClient(address bank, address account);
    error InsufficientReserves(address bank, uint256 required, uint256 available);

    /// @param centralBank_ The CentralBank contract (bank registry + wCBDC source).
    constructor(CentralBank centralBank_) {
        centralBank = centralBank_;
        wcbdc = centralBank_.wcbdc();
    }

    /// @notice Direct, payer-initiated settlement: `msg.sender` pays `to`.
    /// @dev Phase 2 scaffolding — to be removed in Phase 3 when EIP-712 intents land.
    ///      The routing rule reserves the dual gasless/direct path to sEUR alone, and the
    ///      relayer-censorship scenario (V2) requires deposits to be exclusively
    ///      intermediated. Phase 3's `executeIntent` will reuse `_settle` unchanged.
    /// @param fromBank The payer's bank (must be registered with the CentralBank).
    /// @param toBank The payee's bank (must be registered with the CentralBank).
    /// @param to The payee (must be a client of `toBank`).
    /// @param amount Amount in 6-decimals units.
    function settle(address fromBank, address toBank, address to, uint256 amount) external {
        _settle(msg.sender, fromBank, toBank, to, amount);
    }

    /// @dev Settlement core, shared by the direct path (Phase 2) and the intent path
    ///      (Phase 3). Checks-effects-interactions: all external calls target trusted
    ///      system contracts validated against the CentralBank registry.
    function _settle(address from, address fromBank, address toBank, address to, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        if (!centralBank.isRegisteredBank(fromBank)) revert NotRegisteredBank(fromBank);
        if (!centralBank.isRegisteredBank(toBank)) revert NotRegisteredBank(toBank);

        CommercialBank payerBank = CommercialBank(fromBank);
        CommercialBank payeeBank = CommercialBank(toBank);
        if (!payerBank.isClient(from)) revert NotBankClient(fromBank, from);
        if (!payeeBank.isClient(to)) revert NotBankClient(toBank, to);

        if (fromBank == toBank) {
            // Intrabank: pure book transfer on the bank's ledger — no central bank money
            // moves and the deposit supply is untouched.
            payerBank.depositToken().settle(from, to, amount);
            emit IntrabankTransfer(fromBank, from, to, amount);
            return;
        }

        // Hard (physical) constraint: the paying bank settles in central bank money it
        // actually holds. This is the ILLIQUID state — the only thing that ever blocks a
        // payment (trap #4). Explicit pre-check for a readable error; the wcbdc.settle
        // below would revert regardless.
        uint256 available = wcbdc.balanceOf(fromBank);
        if (available < amount) revert InsufficientReserves(fromBank, amount, available);

        // Atomic interbank settlement: the three legs share this transaction, so equal
        // amounts of M1 burned, M0 moved and M1 minted — or nothing (INVARIANTS 2, 7).
        payerBank.depositToken().burn(from, amount);
        wcbdc.settle(fromBank, toBank, amount);
        payeeBank.depositToken().mint(to, amount);
        emit Settled(from, fromBank, toBank, to, amount);

        // Soft (regulatory) constraint: the paying bank flags itself if the outflow put
        // it below the threshold. The receiving bank's ratio mechanically improves
        // (numerator and denominator grow by the same amount), so no check on that side.
        payerBank.checkReserveRatio();
    }
}

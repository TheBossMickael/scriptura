// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {CentralBank} from "./CentralBank.sol";
import {CommercialBank} from "./CommercialBank.sol";
import {WCBDC} from "./WCBDC.sol";

/// @title SettlementEngine — atomic interbank settlement in central bank money
/// @notice The system's core: routes a client payment either as an intrabank book
///         transfer (same bank, no wCBDC) or as an interbank settlement — burn the
///         payer's deposits, move wCBDC between bank reserves, mint deposits to the
///         payee — all within one transaction (INVARIANTS 2 and 7).
///         Payments enter exclusively as EIP-712 `PaymentIntent`s signed by the payer
///         and submitted by anyone (normally the gasless relayer): the engine is
///         relay-agnostic, so relayer censorship is operational, never contractual —
///         a client may always self-relay by paying their own gas.
/// @dev Stateless apart from intent nonces: banks are validated against the CentralBank
///      registry per call, deposit tokens discovered via `CommercialBank.depositToken()`.
///      Intent nonces are sequential per payer (OZ Nonces); they deliberately differ from
///      sEUR's random EIP-3009 nonces (trap #3) — do not unify the two systems.
contract SettlementEngine is EIP712, Nonces {
    /// @notice A client-signed payment order. Field order matches CLAUDE.md.
    /// @dev `nonce` must equal `nonces(from)` at execution time (sequential, anti-replay);
    ///      `deadline` is the last valid UNIX timestamp, inclusive (ERC20Permit semantics).
    struct PaymentIntent {
        address from;
        address fromBank;
        address toBank;
        address to;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(address from,address fromBank,address toBank,address to,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    /// @notice The central bank, used as the registry of valid commercial banks.
    CentralBank public immutable centralBank;

    /// @notice The wCBDC token reserves are settled in.
    WCBDC public immutable wcbdc;

    event Settled(address indexed from, address indexed fromBank, address indexed toBank, address to, uint256 amount);
    event IntrabankTransfer(address indexed bank, address indexed from, address indexed to, uint256 amount);
    event IntentExecuted(bytes32 indexed digest, address indexed from, uint256 nonce);

    error ZeroAmount();
    error NotRegisteredBank(address bank);
    error NotBankClient(address bank, address account);
    error InsufficientReserves(address bank, uint256 required, uint256 available);
    error IntentExpired(uint256 deadline);
    error InvalidIntentSigner(address recovered, address expected);

    /// @param centralBank_ The CentralBank contract (bank registry + wCBDC source).
    constructor(CentralBank centralBank_) EIP712("SettlementEngine", "1") {
        centralBank = centralBank_;
        wcbdc = centralBank_.wcbdc();
    }

    /// @notice Executes a payer-signed payment intent. Callable by anyone holding a valid
    ///         signature — the submitter (usually the relayer) pays gas, the payer's
    ///         signature is the sole authorization.
    /// @dev Verification order: deadline, ECDSA signature, sequential nonce
    ///      (`_useCheckedNonce` reverts with OZ `InvalidAccountNonce` on replay or gap,
    ///      INVARIANT 6), then settlement. The digest is emitted so off-chain consumers
    ///      (relayer cache, frontend status tracking) can correlate intent and execution.
    /// @param intent The payment order, signed by `intent.from`.
    /// @param signature ECDSA signature of the EIP-712 digest (`hashIntent(intent)`).
    function executeIntent(PaymentIntent calldata intent, bytes calldata signature) external {
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline);

        bytes32 digest = _hashIntent(intent);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != intent.from) revert InvalidIntentSigner(recovered, intent.from);

        _useCheckedNonce(intent.from, intent.nonce);
        _settle(intent.from, intent.fromBank, intent.toBank, intent.to, intent.amount);
        emit IntentExecuted(digest, intent.from, intent.nonce);
    }

    /// @notice EIP-712 digest of a payment intent — what the payer signs. Exposed so the
    ///         relayer, frontend and tests share one canonical hashing implementation
    ///         (also the relayer's idempotency key).
    /// @param intent The payment order to hash.
    function hashIntent(PaymentIntent calldata intent) external view returns (bytes32) {
        return _hashIntent(intent);
    }

    /// @dev EIP-712 structured hash bound to this chain and contract (domain separator).
    function _hashIntent(PaymentIntent calldata intent) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYMENT_INTENT_TYPEHASH,
                    intent.from,
                    intent.fromBank,
                    intent.toBank,
                    intent.to,
                    intent.amount,
                    intent.nonce,
                    intent.deadline
                )
            )
        );
    }

    /// @dev Settlement core, shared history: served the Phase 2 direct path, now reached
    ///      only through `executeIntent`. Phase 4's StableCo (a contract, unable to
    ///      ECDSA-sign) will get its own restricted entry point on top of this.
    ///      Checks-effects-interactions: all external calls target trusted system
    ///      contracts validated against the CentralBank registry.
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

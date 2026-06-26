// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {CommercialBank} from "./CommercialBank.sol";
import {DepositToken} from "./DepositToken.sol";
import {SettlementEngine} from "./SettlementEngine.sol";
import {StableEUR} from "./StableEUR.sol";

/// @title StableCo — reserve vault issuing the sEUR stablecoin 1:1 against deposits
/// @notice Holds DEP-A reserves and mints/redeems sEUR endogenously: a client signs a
///         MintIntent / RedeemIntent (EIP-712), this vault verifies it and composes — in
///         ONE transaction — the settlement leg (through the engine) with the sEUR
///         mint/burn. Registered as a client of Bank A, where its reserves live.
/// @dev Cross-bank is the richest path (trap #1): a Bank B client minting/redeeming triggers
///      an interbank settlement (wCBDC B<->A) inside the same tx, with no branching here —
///      the engine routes same-bank vs interbank from the client's bank. Operation ordering
///      keeps the 100% coverage invariant (INVARIANT 3) holding at every step: on mint
///      reserves arrive before sEUR is minted; on redeem sEUR is burned before reserves
///      leave. The operator's ONLY power is pause()/unpause() — there is NO admin mint
///      (trap #2). Mint/redeem nonces are sequential per user (OZ Nonces), a namespace
///      distinct from both the engine's nonces and sEUR's random EIP-3009 nonces (trap #3).
contract StableCo is EIP712, Nonces, AccessControl, Pausable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice A client-signed order to mint sEUR against deposits.
    /// @dev `nonce` must equal `nonces(minter)` (sequential, anti-replay); `deadline` is the
    ///      last valid UNIX timestamp, inclusive.
    struct MintIntent {
        address minter;
        address minterBank;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice A client-signed order to redeem sEUR back into deposits.
    struct RedeemIntent {
        address redeemer;
        address redeemerBank;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant MINT_INTENT_TYPEHASH =
        keccak256("MintIntent(address minter,address minterBank,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 public constant REDEEM_INTENT_TYPEHASH =
        keccak256("RedeemIntent(address redeemer,address redeemerBank,uint256 amount,uint256 nonce,uint256 deadline)");

    /// @notice The settlement engine composing the deposit legs.
    SettlementEngine public immutable engine;

    /// @notice Bank A — where this vault is a client and its DEP-A reserves are held.
    CommercialBank public immutable bankA;

    /// @notice The DEP-A token backing sEUR (== bankA.depositToken()).
    DepositToken public immutable depA;

    /// @notice The sEUR token, deployed and solely administered by this vault.
    StableEUR public immutable seur;

    event StableMinted(address indexed minter, address indexed minterBank, uint256 amount);
    event StableRedeemed(address indexed redeemer, address indexed redeemerBank, uint256 amount);

    error ZeroAmount();
    error IntentExpired(uint256 deadline);
    error InvalidIntentSigner(address recovered, address expected);

    /// @param engine_ The SettlementEngine (must have StableCo wired via setStableCo).
    /// @param bankA_ Bank A, this vault's bank and reserve location.
    /// @param operator The StableCo operator EOA — can only pause()/unpause().
    constructor(SettlementEngine engine_, CommercialBank bankA_, address operator) EIP712("StableCo", "1") {
        engine = engine_;
        bankA = bankA_;
        depA = bankA_.depositToken();
        // Atomic wiring (CentralBank->WCBDC, CommercialBank->DepositToken pattern): sEUR is
        // born with this vault as its sole admin/minter/burner. No EOA can mint (trap #2).
        seur = new StableEUR(address(this));
        _grantRole(DEFAULT_ADMIN_ROLE, operator);
        _grantRole(OPERATOR_ROLE, operator);
    }

    /*//////////////////////////////////////////////////////////////
                              MINT / REDEEM
    //////////////////////////////////////////////////////////////*/

    /// @notice Mints sEUR to the minter against an equal amount of their deposits. Anyone
    ///         may submit the signed intent (relay-agnostic, like the engine); the minter's
    ///         signature is the sole authorization, so the relayer can pay gas (gasless).
    /// @dev Coverage-safe ordering (INVARIANT 3): reserves arrive BEFORE sEUR is minted.
    ///      `settleToStable` routes same-bank (book transfer) or cross-bank (interbank
    ///      settlement) inside the engine — this vault passes only the minter's bank.
    /// @param intent The mint order, signed by `intent.minter`.
    /// @param signature ECDSA signature over `hashMintIntent(intent)`.
    function mintFromIntent(MintIntent calldata intent, bytes calldata signature) external whenNotPaused {
        if (intent.amount == 0) revert ZeroAmount();
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline);
        address recovered = ECDSA.recover(_hashMintIntent(intent), signature);
        if (recovered != intent.minter) revert InvalidIntentSigner(recovered, intent.minter);
        _useCheckedNonce(intent.minter, intent.nonce);

        engine.settleToStable(intent.minter, intent.minterBank, intent.amount);
        seur.mint(intent.minter, intent.amount);
        emit StableMinted(intent.minter, intent.minterBank, intent.amount);
    }

    /// @notice Redeems the redeemer's sEUR back into an equal amount of deposits. Relay-
    ///         agnostic and gasless, same as mint.
    /// @dev Coverage-safe ordering (INVARIANT 3): sEUR is burned BEFORE reserves leave. The
    ///      burn takes no allowance — the signed RedeemIntent is the authorization and this
    ///      vault is the sole BURNER_ROLE holder. `settleFromStable` routes same/cross-bank.
    /// @param intent The redeem order, signed by `intent.redeemer`.
    /// @param signature ECDSA signature over `hashRedeemIntent(intent)`.
    function redeemFromIntent(RedeemIntent calldata intent, bytes calldata signature) external whenNotPaused {
        if (intent.amount == 0) revert ZeroAmount();
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline);
        address recovered = ECDSA.recover(_hashRedeemIntent(intent), signature);
        if (recovered != intent.redeemer) revert InvalidIntentSigner(recovered, intent.redeemer);
        _useCheckedNonce(intent.redeemer, intent.nonce);

        seur.burn(intent.redeemer, intent.amount);
        engine.settleFromStable(intent.redeemer, intent.redeemerBank, intent.amount);
        emit StableRedeemed(intent.redeemer, intent.redeemerBank, intent.amount);
    }

    /*//////////////////////////////////////////////////////////////
                              EIP-712 DIGESTS
    //////////////////////////////////////////////////////////////*/

    /// @notice EIP-712 digest of a mint intent — what the minter signs (also the relayer's
    ///         idempotency key). Exposed so relayer, frontend and tests share one hashing.
    /// @param intent The mint order to hash.
    function hashMintIntent(MintIntent calldata intent) external view returns (bytes32) {
        return _hashMintIntent(intent);
    }

    /// @notice EIP-712 digest of a redeem intent — what the redeemer signs.
    /// @param intent The redeem order to hash.
    function hashRedeemIntent(RedeemIntent calldata intent) external view returns (bytes32) {
        return _hashRedeemIntent(intent);
    }

    function _hashMintIntent(MintIntent calldata intent) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MINT_INTENT_TYPEHASH, intent.minter, intent.minterBank, intent.amount, intent.nonce, intent.deadline
                )
            )
        );
    }

    function _hashRedeemIntent(RedeemIntent calldata intent) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    REDEEM_INTENT_TYPEHASH,
                    intent.redeemer,
                    intent.redeemerBank,
                    intent.amount,
                    intent.nonce,
                    intent.deadline
                )
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                           RESERVES / OPERATOR
    //////////////////////////////////////////////////////////////*/

    /// @notice The DEP-A reserves backing sEUR (proof of reserves is fully on-chain).
    function reserves() public view returns (uint256) {
        return depA.balanceOf(address(this));
    }

    /// @notice Coverage ratio in basis points: reserves / sEUR supply (>= 10_000 = 100%).
    /// @dev Returns type(uint256).max when no sEUR is outstanding (trivially covered).
    function coverageRatioBps() external view returns (uint256) {
        uint256 supply = seur.totalSupply();
        if (supply == 0) return type(uint256).max;
        return reserves() * BPS_DENOMINATOR / supply;
    }

    /// @notice Suspends mint and redeem (the operator's only power). sEUR keeps circulating
    ///         — a paused issuer does not freeze the money already in the wild.
    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }

    /// @notice Resumes mint and redeem.
    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }
}

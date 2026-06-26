// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title StableEUR — fiat-backed stablecoin (sEUR), permissionless ERC-20 + EIP-3009
/// @notice Unlike the restricted M0/M1 tokens, sEUR has no holder allowlist: anyone may
///         hold and transfer it, and it keeps circulating even when StableCo is paused or
///         the relayer is down — the desintermediation demo. Two P2P paths coexist:
///         a plain `transfer()` (the holder pays gas) and gasless EIP-3009
///         `transferWithAuthorization` (a relayer pays gas against the holder's signature).
/// @dev Supply is ENDOGENOUS (trap #2): no EOA ever holds a minter role. Only StableCo —
///      the sole admin/minter/burner, wired atomically in its constructor — creates sEUR
///      against received reserves and destroys it on redeem. EIP-3009 uses RANDOM 32-byte
///      nonces with a used-nonce map (deliberately different from the engine's sequential
///      nonces, trap #3 — the two systems are never unified).
contract StableEUR is ERC20, EIP712, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /// @dev EIP-3009 type hashes (https://eips.ethereum.org/EIPS/eip-3009).
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @notice True once an authorization (authorizer, nonce) has been used or cancelled.
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid(uint256 validAfter);
    error AuthorizationExpired(uint256 validBefore);
    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error InvalidAuthorizationSigner(address recovered, address authorizer);
    error CallerNotPayee(address caller, address payee);

    /// @param issuer The StableCo vault: sole admin, minter and burner. Deploys this token
    ///               in its constructor, so no configuration window exists where an EOA
    ///               could grab issuance rights (trap #2).
    constructor(address issuer) ERC20("Stable EUR", "sEUR") EIP712("Stable EUR", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, issuer);
        _grantRole(MINTER_ROLE, issuer);
        _grantRole(BURNER_ROLE, issuer);
    }

    /// @notice All tokens of the system use 6 decimals (USDC style).
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints sEUR to a buyer. Reachable only through StableCo, atomically with a
    ///         reserve inflow — never as a standalone admin action (trap #2).
    /// @param to The buyer receiving freshly issued sEUR.
    /// @param amount Amount in 6-decimals units.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Burns a redeemer's sEUR. No allowance is required: StableCo (the sole
    ///         BURNER_ROLE holder) only burns after verifying the redeemer's signed
    ///         RedeemIntent — the signature is the authorization.
    /// @param from The redeemer whose sEUR is destroyed.
    /// @param amount Amount in 6-decimals units.
    function burn(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 EIP-3009
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns whether an authorization nonce has already been used or cancelled.
    /// @param authorizer The account that would have signed the authorization.
    /// @param nonce The random 32-byte authorization nonce.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice Executes a transfer pre-authorized by `from`'s EIP-712 signature (gasless
    ///         P2P path #1: any submitter — typically the relayer — pays gas).
    /// @param from The payer (and signer of the authorization).
    /// @param to The recipient.
    /// @param value Amount in 6-decimals units.
    /// @param validAfter Authorization valid strictly after this UNIX timestamp.
    /// @param validBefore Authorization valid strictly before this UNIX timestamp.
    /// @param nonce Unique random 32-byte nonce chosen by the signer.
    /// @param signature ECDSA signature over the EIP-712 TransferWithAuthorization digest.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        _verifyAndMarkAuthorization(from, nonce, structHash, signature);
        _transfer(from, to, value);
    }

    /// @notice Like `transferWithAuthorization` but only the intended recipient may submit
    ///         it (`msg.sender == to`), preventing a front-runner from redirecting or
    ///         replaying the call. Implemented for EIP-3009 conformance; the relayer's
    ///         gasless path uses `transferWithAuthorization`.
    /// @param from The payer (and signer of the authorization).
    /// @param to The recipient — must be the caller.
    /// @param value Amount in 6-decimals units.
    /// @param validAfter Authorization valid strictly after this UNIX timestamp.
    /// @param validBefore Authorization valid strictly before this UNIX timestamp.
    /// @param nonce Unique random 32-byte nonce chosen by the signer.
    /// @param signature ECDSA signature over the EIP-712 ReceiveWithAuthorization digest.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (msg.sender != to) revert CallerNotPayee(msg.sender, to);
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        _verifyAndMarkAuthorization(from, nonce, structHash, signature);
        _transfer(from, to, value);
    }

    /// @notice Cancels an unused authorization, signed by its authorizer. Lets a signer
    ///         invalidate a leaked or stale off-chain authorization before it is used.
    /// @param authorizer The account that signed the authorization being cancelled.
    /// @param nonce The authorization nonce to invalidate.
    /// @param signature ECDSA signature over the EIP-712 CancelAuthorization digest.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != authorizer) revert InvalidAuthorizationSigner(recovered, authorizer);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// @dev Validity window (strict both ends, per EIP-3009) + unused-nonce check.
    function _requireValidAuthorization(address authorizer, bytes32 nonce, uint256 validAfter, uint256 validBefore)
        private
        view
    {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore);
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
    }

    /// @dev Recovers the signer, requires it to equal the authorizer, then consumes the
    ///      nonce (checks-effects-interactions: state marked before `_transfer`).
    function _verifyAndMarkAuthorization(
        address authorizer,
        bytes32 nonce,
        bytes32 structHash,
        bytes calldata signature
    ) private {
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != authorizer) revert InvalidAuthorizationSigner(recovered, authorizer);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }
}

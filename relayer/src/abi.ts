import { parseAbi } from "viem";

/**
 * Hand-rolled minimal ABI of the SettlementEngine — only what the relayer calls,
 * plus every custom error reachable through executeIntent (engine, OZ Nonces/ECDSA,
 * DepositToken, WCBDC, Pausable) so simulation reverts decode to readable names.
 */
export const settlementEngineAbi = parseAbi([
  "struct PaymentIntent { address from; address fromBank; address toBank; address to; uint256 amount; uint256 nonce; uint256 deadline; }",
  "function executeIntent(PaymentIntent intent, bytes signature)",
  "function nonces(address owner) view returns (uint256)",
  "function hashIntent(PaymentIntent intent) view returns (bytes32)",
  "event IntentExecuted(bytes32 indexed digest, address indexed from, uint256 nonce)",
  "event Settled(address indexed from, address indexed fromBank, address indexed toBank, address to, uint256 amount)",
  "event IntrabankTransfer(address indexed bank, address indexed from, address indexed to, uint256 amount)",
  // SettlementEngine errors
  "error ZeroAmount()",
  "error NotRegisteredBank(address bank)",
  "error NotBankClient(address bank, address account)",
  "error InsufficientReserves(address bank, uint256 required, uint256 available)",
  "error IntentExpired(uint256 deadline)",
  "error InvalidIntentSigner(address recovered, address expected)",
  // OZ Nonces / ECDSA
  "error InvalidAccountNonce(address account, uint256 currentNonce)",
  "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256 length)",
  "error ECDSAInvalidSignatureS(bytes32 s)",
  // DepositToken / WCBDC / Pausable (reverts surfacing through _settle)
  "error NotClient(address account)",
  "error NotAllowlisted(address account)",
  "error EnforcedPause()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

/**
 * Hand-rolled ABI of StableCo — mint/redeem composition entry points, the sequential nonce
 * reader, the digest views, and every custom error reachable through them (StableCo, engine
 * via settleTo/FromStable, DepositToken/WCBDC/Pausable) so simulation reverts decode.
 */
export const stableCoAbi = parseAbi([
  "struct MintIntent { address minter; address minterBank; uint256 amount; uint256 nonce; uint256 deadline; }",
  "struct RedeemIntent { address redeemer; address redeemerBank; uint256 amount; uint256 nonce; uint256 deadline; }",
  "function mintFromIntent(MintIntent intent, bytes signature)",
  "function redeemFromIntent(RedeemIntent intent, bytes signature)",
  "function nonces(address owner) view returns (uint256)",
  "function hashMintIntent(MintIntent intent) view returns (bytes32)",
  "function hashRedeemIntent(RedeemIntent intent) view returns (bytes32)",
  "event StableMinted(address indexed minter, address indexed minterBank, uint256 amount)",
  "event StableRedeemed(address indexed redeemer, address indexed redeemerBank, uint256 amount)",
  // StableCo errors
  "error ZeroAmount()",
  "error IntentExpired(uint256 deadline)",
  "error InvalidIntentSigner(address recovered, address expected)",
  "error EnforcedPause()",
  // OZ Nonces / ECDSA
  "error InvalidAccountNonce(address account, uint256 currentNonce)",
  "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256 length)",
  "error ECDSAInvalidSignatureS(bytes32 s)",
  // Engine / DepositToken / WCBDC reverts surfacing through the settlement legs
  "error NotStableCo()",
  "error NotRegisteredBank(address bank)",
  "error NotBankClient(address bank, address account)",
  "error InsufficientReserves(address bank, uint256 required, uint256 available)",
  "error NotClient(address account)",
  "error NotAllowlisted(address account)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

/**
 * Hand-rolled ABI of StableEUR — the gasless EIP-3009 transfer path, the used-nonce reader,
 * and the authorization custom errors for revert decoding.
 */
export const seurAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "error AuthorizationNotYetValid(uint256 validAfter)",
  "error AuthorizationExpired(uint256 validBefore)",
  "error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce)",
  "error InvalidAuthorizationSigner(address recovered, address authorizer)",
  "error CallerNotPayee(address caller, address payee)",
]);

/**
 * Hand-rolled ABI of CommercialBank — the Option B faucet onboarding entry point and the
 * reverts reachable through it, so the relayer can simulate + decode them.
 */
export const commercialBankAbi = parseAbi([
  "function onboard(address client, uint256 amount)",
  "function isClient(address account) view returns (bool)",
  "event ClientRegistered(address indexed client)",
  "event ClientCredited(address indexed client, uint256 amount)",
  "error AlreadyClient(address account)",
  "error FaucetAmountTooHigh(uint256 amount, uint256 max)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error EnforcedPause()",
  "error NotClient(address account)",
]);

/** Minimal ERC-20 view ABI (smoke script balance reads). */
export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

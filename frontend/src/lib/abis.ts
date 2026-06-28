import { parseAbi } from "viem";

/**
 * Hand-written viem ABIs for the Two-Tier Money Sandbox contracts, owned by the frontend
 * (same convention as `relayer/src/abi.ts` and `indexer/abis.ts`: each project declares the
 * minimal ABIs it needs). Covers everything the UI touches: view reads, operator/direct
 * writes, EIP-712 structs for signing, events, and the custom errors worth decoding.
 */

/** WCBDC — restricted ERC-20, layer M0. */
export const wcbdcAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function isAllowlisted(address account) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AllowlistUpdated(address indexed account, bool allowed)",
]);

/** CentralBank — wCBDC issuer, bank registry, regulatory ratio parameter. */
export const centralBankAbi = parseAbi([
  "function reserveRatioThresholdBps() view returns (uint256)",
  "function isRegisteredBank(address bank) view returns (bool)",
  "function settlementEngine() view returns (address)",
  "function wcbdc() view returns (address)",
  "function OPERATOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function registerBank(address bank)",
  "function removeBank(address bank)",
  "function setReserveRatioThreshold(uint256 newThresholdBps)",
  "event BankRegistered(address indexed bank)",
  "event BankRemoved(address indexed bank)",
  "event ReserveRatioThresholdUpdated(uint256 previousBps, uint256 newBps)",
  "error ThresholdAboveMax(uint256 bps)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);

/** CommercialBank (x2: A, B) — reserves, client registry, freeze, faucet onboard. */
export const commercialBankAbi = parseAbi([
  "function reserves() view returns (uint256)",
  "function reserveRatioBps() view returns (uint256)",
  "function isClient(address account) view returns (bool)",
  "function depositToken() view returns (address)",
  "function settlementEngine() view returns (address)",
  "function MAX_FAUCET_CREDIT() view returns (uint256)",
  "function OPERATOR_ROLE() view returns (bytes32)",
  "function FAUCET_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function registerClient(address client)",
  "function removeClient(address client)",
  "function creditClient(address client, uint256 amount)",
  "function freeze()",
  "function unfreeze()",
  "function onboard(address client, uint256 amount)",
  "event ClientRegistered(address indexed client)",
  "event ClientRemoved(address indexed client)",
  "event ClientCredited(address indexed client, uint256 amount)",
  "event BankFrozen()",
  "event BankUnfrozen()",
  "event ReserveRatioBreached(address indexed bank, uint256 ratioBps, uint256 thresholdBps)",
  "error AlreadyClient(address account)",
  "error NotClient(address account)",
  "error ClientHasBalance(address client, uint256 balance)",
  "error FaucetAmountTooHigh(uint256 amount, uint256 max)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error EnforcedPause()",
]);

/** DepositToken (x2: DEP-A, DEP-B) — restricted ERC-20, layer M1, pausable. */
export const depositTokenAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function paused() view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Paused(address account)",
  "event Unpaused(address account)",
]);

/** SettlementEngine — EIP-712 PaymentIntent, atomic interbank settlement. */
export const settlementEngineAbi = parseAbi([
  "struct PaymentIntent { address from; address fromBank; address toBank; address to; uint256 amount; uint256 nonce; uint256 deadline; }",
  "function executeIntent(PaymentIntent intent, bytes signature)",
  "function nonces(address owner) view returns (uint256)",
  "function hashIntent(PaymentIntent intent) view returns (bytes32)",
  "function stableCo() view returns (address)",
  "event Settled(address indexed from, address indexed fromBank, address indexed toBank, address to, uint256 amount)",
  "event IntrabankTransfer(address indexed bank, address indexed from, address indexed to, uint256 amount)",
  "event IntentExecuted(bytes32 indexed digest, address indexed from, uint256 nonce)",
  "error ZeroAmount()",
  "error NotRegisteredBank(address bank)",
  "error NotBankClient(address bank, address account)",
  "error InsufficientReserves(address bank, uint256 required, uint256 available)",
  "error IntentExpired(uint256 deadline)",
  "error InvalidIntentSigner(address recovered, address expected)",
  "error InvalidAccountNonce(address account, uint256 currentNonce)",
]);

/** StableCo — EIP-712 MintIntent/RedeemIntent, endogenous sEUR issuance. */
export const stableCoAbi = parseAbi([
  "struct MintIntent { address minter; address minterBank; uint256 amount; uint256 nonce; uint256 deadline; }",
  "struct RedeemIntent { address redeemer; address redeemerBank; uint256 amount; uint256 nonce; uint256 deadline; }",
  "function mintFromIntent(MintIntent intent, bytes signature)",
  "function redeemFromIntent(RedeemIntent intent, bytes signature)",
  "function nonces(address owner) view returns (uint256)",
  "function reserves() view returns (uint256)",
  "function coverageRatioBps() view returns (uint256)",
  "function paused() view returns (bool)",
  "function seur() view returns (address)",
  "function depA() view returns (address)",
  "function bankA() view returns (address)",
  "function OPERATOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function pause()",
  "function unpause()",
  "event StableMinted(address indexed minter, address indexed minterBank, uint256 amount)",
  "event StableRedeemed(address indexed redeemer, address indexed redeemerBank, uint256 amount)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "error ZeroAmount()",
  "error IntentExpired(uint256 deadline)",
  "error InvalidIntentSigner(address recovered, address expected)",
  "error EnforcedPause()",
  "error InvalidAccountNonce(address account, uint256 currentNonce)",
]);

/** StableEUR — permissionless ERC-20 + EIP-3009, the sEUR stablecoin. */
export const seurAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

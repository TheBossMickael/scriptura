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

/** Minimal ERC-20 view ABI (smoke script balance reads). */
export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

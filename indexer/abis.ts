import { parseAbi } from "viem";

/**
 * Event ABIs of the contracts this indexer watches. Hand-written and local to this project
 * (same convention as `relayer/src/abi.ts`): each project owns the minimal ABIs it needs.
 * Only events are listed — Ponder indexes events, not function calls.
 */

/** SettlementEngine — interbank settlement + intrabank book transfers. */
export const settlementEngineAbi = parseAbi([
  "event Settled(address indexed from, address indexed fromBank, address indexed toBank, address to, uint256 amount)",
  "event IntrabankTransfer(address indexed bank, address indexed from, address indexed to, uint256 amount)",
]);

/** CommercialBank (A and B) — ratio breaches, freezes, client registry/credit events. */
export const commercialBankAbi = parseAbi([
  "event ReserveRatioBreached(address indexed bank, uint256 ratioBps, uint256 thresholdBps)",
  "event BankFrozen()",
  "event BankUnfrozen()",
  "event ClientRegistered(address indexed client)",
  "event ClientRemoved(address indexed client)",
  "event ClientCredited(address indexed client, uint256 amount)",
]);

/** StableCo — sEUR mint/redeem flows. */
export const stableCoAbi = parseAbi([
  "event StableMinted(address indexed minter, address indexed minterBank, uint256 amount)",
  "event StableRedeemed(address indexed redeemer, address indexed redeemerBank, uint256 amount)",
]);

/** StableEUR — ERC-20 transfers (P2P + mint/burn legs). */
export const seurAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

import { onchainTable, primaryKey } from "ponder";

/**
 * Derived projection of the on-chain monetary history (the chain stays the source of truth;
 * this DB is fully rebuildable from logs). Tables map 1:1 to the rich events the frontend
 * needs for history walls and aggregates. uint256 values use Ponder's `bigint` (numeric,
 * not native 8-byte int); addresses/hashes use `hex`. Reserved SQL words (from/to/value)
 * are avoided in column names.
 */

/** A monetary payment — interbank settlement (`Settled`) or intrabank book transfer. */
export const payment = onchainTable("payment", (t) => ({
  id: t.text().primaryKey(),
  kind: t.text().notNull(), // "interbank" | "intrabank"
  sender: t.hex().notNull(),
  recipient: t.hex().notNull(),
  fromBank: t.hex().notNull(),
  toBank: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** A sEUR issuance (`StableMinted`) or redemption (`StableRedeemed`). */
export const stableFlow = onchainTable("stable_flow", (t) => ({
  id: t.text().primaryKey(),
  kind: t.text().notNull(), // "mint" | "redeem"
  account: t.hex().notNull(),
  bank: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** A soft regulatory breach (`ReserveRatioBreached`) — the central bank's alert wall. */
export const ratioBreach = onchainTable("ratio_breach", (t) => ({
  id: t.text().primaryKey(),
  bank: t.hex().notNull(),
  ratioBps: t.bigint().notNull(),
  thresholdBps: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** A bank freeze/unfreeze (`BankFrozen`/`BankUnfrozen`). */
export const bankStatusEvent = onchainTable("bank_status_event", (t) => ({
  id: t.text().primaryKey(),
  bank: t.hex().notNull(),
  frozen: t.boolean().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** A client registry / credit event (`ClientRegistered`/`ClientCredited`/`ClientRemoved`). */
export const clientEvent = onchainTable("client_event", (t) => ({
  id: t.text().primaryKey(),
  kind: t.text().notNull(), // "registered" | "credited" | "removed"
  bank: t.hex().notNull(),
  client: t.hex().notNull(),
  amount: t.bigint().notNull(), // 0 for register/remove
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** Current client-registry membership per bank (for the operator's client list). */
export const client = onchainTable(
  "client",
  (t) => ({
    bank: t.hex().notNull(),
    address: t.hex().notNull(),
    active: t.boolean().notNull(),
    registeredAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.bank, table.address] }),
  }),
);

/** A P2P sEUR transfer (excludes mint/burn legs). */
export const seurTransfer = onchainTable("seur_transfer", (t) => ({
  id: t.text().primaryKey(),
  sender: t.hex().notNull(),
  recipient: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** Running sEUR balance per holder (for the StableCo "top holders" view). */
export const seurHolder = onchainTable("seur_holder", (t) => ({
  address: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
}));

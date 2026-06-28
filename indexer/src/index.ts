import { ponder } from "ponder:registry";
import type { Context } from "ponder:registry";
import schema from "ponder:schema";
import { type Hex, zeroAddress } from "viem";

/**
 * Indexing functions: turn the system's rich events into the derived tables the frontend
 * reads. Bank A and Bank B share the same ABI, so their handlers call shared helpers; the
 * `db` is typed via the registry Context so helpers stay type-safe without `any`.
 */

type IndexingDb = Context["db"];

interface RowMeta {
  id: string;
  blockNumber: bigint;
  timestamp: bigint;
  txHash: Hex;
}

/** Common columns lifted from any event (block/tx provenance + unique id). */
function rowMeta(event: {
  id: string;
  block: { number: bigint; timestamp: bigint };
  transaction: { hash: Hex };
}): RowMeta {
  return {
    id: event.id,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  };
}

/*//////////////////////////////////////////////////////////////
                            PAYMENTS
//////////////////////////////////////////////////////////////*/

ponder.on("SettlementEngine:Settled", async ({ event, context }) => {
  await context.db.insert(schema.payment).values({
    ...rowMeta(event),
    kind: "interbank",
    sender: event.args.from,
    recipient: event.args.to,
    fromBank: event.args.fromBank,
    toBank: event.args.toBank,
    amount: event.args.amount,
  });
});

ponder.on("SettlementEngine:IntrabankTransfer", async ({ event, context }) => {
  await context.db.insert(schema.payment).values({
    ...rowMeta(event),
    kind: "intrabank",
    sender: event.args.from,
    recipient: event.args.to,
    fromBank: event.args.bank,
    toBank: event.args.bank,
    amount: event.args.amount,
  });
});

/*//////////////////////////////////////////////////////////////
                          STABLE FLOWS
//////////////////////////////////////////////////////////////*/

ponder.on("StableCo:StableMinted", async ({ event, context }) => {
  await context.db.insert(schema.stableFlow).values({
    ...rowMeta(event),
    kind: "mint",
    account: event.args.minter,
    bank: event.args.minterBank,
    amount: event.args.amount,
  });
});

ponder.on("StableCo:StableRedeemed", async ({ event, context }) => {
  await context.db.insert(schema.stableFlow).values({
    ...rowMeta(event),
    kind: "redeem",
    account: event.args.redeemer,
    bank: event.args.redeemerBank,
    amount: event.args.amount,
  });
});

/*//////////////////////////////////////////////////////////////
                    BANK EVENTS (A and B share)
//////////////////////////////////////////////////////////////*/

async function recordBreach(
  db: IndexingDb,
  bank: Hex,
  ratioBps: bigint,
  thresholdBps: bigint,
  meta: RowMeta,
): Promise<void> {
  await db.insert(schema.ratioBreach).values({ ...meta, bank, ratioBps, thresholdBps });
}

async function recordStatus(db: IndexingDb, bank: Hex, frozen: boolean, meta: RowMeta): Promise<void> {
  await db.insert(schema.bankStatusEvent).values({ ...meta, bank, frozen });
}

async function recordClientRegistered(db: IndexingDb, bank: Hex, account: Hex, meta: RowMeta): Promise<void> {
  await db.insert(schema.clientEvent).values({ ...meta, kind: "registered", bank, client: account, amount: 0n });
  await db
    .insert(schema.client)
    .values({ bank, address: account, active: true, registeredAt: meta.timestamp })
    .onConflictDoUpdate(() => ({ active: true }));
}

async function recordClientCredited(
  db: IndexingDb,
  bank: Hex,
  account: Hex,
  amount: bigint,
  meta: RowMeta,
): Promise<void> {
  await db.insert(schema.clientEvent).values({ ...meta, kind: "credited", bank, client: account, amount });
}

async function recordClientRemoved(db: IndexingDb, bank: Hex, account: Hex, meta: RowMeta): Promise<void> {
  await db.insert(schema.clientEvent).values({ ...meta, kind: "removed", bank, client: account, amount: 0n });
  await db
    .insert(schema.client)
    .values({ bank, address: account, active: false, registeredAt: meta.timestamp })
    .onConflictDoUpdate(() => ({ active: false }));
}

// Bank A
ponder.on("BankA:ReserveRatioBreached", ({ event, context }) =>
  recordBreach(context.db, event.args.bank, event.args.ratioBps, event.args.thresholdBps, rowMeta(event)),
);
ponder.on("BankA:BankFrozen", ({ event, context }) => recordStatus(context.db, event.log.address, true, rowMeta(event)));
ponder.on("BankA:BankUnfrozen", ({ event, context }) =>
  recordStatus(context.db, event.log.address, false, rowMeta(event)),
);
ponder.on("BankA:ClientRegistered", ({ event, context }) =>
  recordClientRegistered(context.db, event.log.address, event.args.client, rowMeta(event)),
);
ponder.on("BankA:ClientCredited", ({ event, context }) =>
  recordClientCredited(context.db, event.log.address, event.args.client, event.args.amount, rowMeta(event)),
);
ponder.on("BankA:ClientRemoved", ({ event, context }) =>
  recordClientRemoved(context.db, event.log.address, event.args.client, rowMeta(event)),
);

// Bank B
ponder.on("BankB:ReserveRatioBreached", ({ event, context }) =>
  recordBreach(context.db, event.args.bank, event.args.ratioBps, event.args.thresholdBps, rowMeta(event)),
);
ponder.on("BankB:BankFrozen", ({ event, context }) => recordStatus(context.db, event.log.address, true, rowMeta(event)));
ponder.on("BankB:BankUnfrozen", ({ event, context }) =>
  recordStatus(context.db, event.log.address, false, rowMeta(event)),
);
ponder.on("BankB:ClientRegistered", ({ event, context }) =>
  recordClientRegistered(context.db, event.log.address, event.args.client, rowMeta(event)),
);
ponder.on("BankB:ClientCredited", ({ event, context }) =>
  recordClientCredited(context.db, event.log.address, event.args.client, event.args.amount, rowMeta(event)),
);
ponder.on("BankB:ClientRemoved", ({ event, context }) =>
  recordClientRemoved(context.db, event.log.address, event.args.client, rowMeta(event)),
);

/*//////////////////////////////////////////////////////////////
                          sEUR TRANSFERS
//////////////////////////////////////////////////////////////*/

ponder.on("SEUR:Transfer", async ({ event, context }) => {
  const { from, to, value } = event.args;

  // P2P transfer history excludes mint (from == 0) and burn (to == 0) legs.
  if (from !== zeroAddress && to !== zeroAddress) {
    await context.db.insert(schema.seurTransfer).values({
      ...rowMeta(event),
      sender: from,
      recipient: to,
      amount: value,
    });
  }

  // Running balances (mint credits `to`, burn debits `from`, transfer does both).
  if (to !== zeroAddress) {
    await context.db
      .insert(schema.seurHolder)
      .values({ address: to, balance: value })
      .onConflictDoUpdate((row) => ({ balance: row.balance + value }));
  }
  if (from !== zeroAddress) {
    await context.db
      .insert(schema.seurHolder)
      .values({ address: from, balance: 0n })
      .onConflictDoUpdate((row) => ({ balance: row.balance - value }));
  }
});

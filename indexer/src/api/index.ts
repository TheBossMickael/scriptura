import { db } from "ponder:api";
import schema from "ponder:schema";
import { and, desc, eq, gt, or, replaceBigInts } from "ponder";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Hex } from "viem";

/**
 * Custom REST API consumed by the frontend. Hand-rolled (instead of the auto GraphQL) so the
 * JSON shape is predictable and decoupled from the GraphQL schema's naming. All reads are
 * public — the data only mirrors public on-chain events; the role only decides which slice
 * the frontend displays. uint256 columns are serialized to decimal strings (JSON has no
 * bigint). CORS is open so the browser app can query directly.
 */

const app = new Hono();

app.use("*", cors());

/** uint256/bigint -> decimal string for JSON transport (the frontend re-parses to BigInt). */
function toJson<T>(rows: T): unknown {
  return replaceBigInts(rows, (value) => value.toString());
}

function normAddress(value: string | undefined): Hex | undefined {
  return value ? (value.toLowerCase() as Hex) : undefined;
}

function clampLimit(value: string | undefined, fallback = 50, max = 500): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Payments: filter by `account` (sender or recipient) and/or `bank` (from or to). */
app.get("/payments", async (c) => {
  const account = normAddress(c.req.query("account"));
  const bank = normAddress(c.req.query("bank"));
  const conditions = [];
  if (account) conditions.push(or(eq(schema.payment.sender, account), eq(schema.payment.recipient, account)));
  if (bank) conditions.push(or(eq(schema.payment.fromBank, bank), eq(schema.payment.toBank, bank)));

  const rows = await db
    .select()
    .from(schema.payment)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.payment.timestamp))
    .limit(clampLimit(c.req.query("limit")));
  return c.json(toJson(rows));
});

/** sEUR mint/redeem flows: filter by `account`. */
app.get("/stable-flows", async (c) => {
  const account = normAddress(c.req.query("account"));
  const rows = await db
    .select()
    .from(schema.stableFlow)
    .where(account ? eq(schema.stableFlow.account, account) : undefined)
    .orderBy(desc(schema.stableFlow.timestamp))
    .limit(clampLimit(c.req.query("limit")));
  return c.json(toJson(rows));
});

/** Reserve-ratio breaches (central bank alert wall): filter by `bank`. */
app.get("/ratio-breaches", async (c) => {
  const bank = normAddress(c.req.query("bank"));
  const rows = await db
    .select()
    .from(schema.ratioBreach)
    .where(bank ? eq(schema.ratioBreach.bank, bank) : undefined)
    .orderBy(desc(schema.ratioBreach.timestamp))
    .limit(clampLimit(c.req.query("limit")));
  return c.json(toJson(rows));
});

/** Bank freeze/unfreeze history: filter by `bank`. */
app.get("/bank-status", async (c) => {
  const bank = normAddress(c.req.query("bank"));
  const rows = await db
    .select()
    .from(schema.bankStatusEvent)
    .where(bank ? eq(schema.bankStatusEvent.bank, bank) : undefined)
    .orderBy(desc(schema.bankStatusEvent.timestamp))
    .limit(clampLimit(c.req.query("limit")));
  return c.json(toJson(rows));
});

/** Current client registry for a bank (operator client list). `active` defaults to true. */
app.get("/clients", async (c) => {
  const bank = normAddress(c.req.query("bank"));
  const includeInactive = c.req.query("active") === "false";
  const conditions = [];
  if (bank) conditions.push(eq(schema.client.bank, bank));
  if (!includeInactive) conditions.push(eq(schema.client.active, true));

  const rows = await db
    .select()
    .from(schema.client)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.client.registeredAt))
    .limit(clampLimit(c.req.query("limit"), 200));
  return c.json(toJson(rows));
});

/** P2P sEUR transfers: filter by `account` (sender or recipient). */
app.get("/seur-transfers", async (c) => {
  const account = normAddress(c.req.query("account"));
  const rows = await db
    .select()
    .from(schema.seurTransfer)
    .where(account ? or(eq(schema.seurTransfer.sender, account), eq(schema.seurTransfer.recipient, account)) : undefined)
    .orderBy(desc(schema.seurTransfer.timestamp))
    .limit(clampLimit(c.req.query("limit")));
  return c.json(toJson(rows));
});

/** Top sEUR holders by balance (StableCo distribution view). */
app.get("/seur-holders", async (c) => {
  const rows = await db
    .select()
    .from(schema.seurHolder)
    .where(gt(schema.seurHolder.balance, 0n))
    .orderBy(desc(schema.seurHolder.balance))
    .limit(clampLimit(c.req.query("limit"), 20, 100));
  return c.json(toJson(rows));
});

export default app;

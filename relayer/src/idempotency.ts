import type { Hex } from "viem";

export type IntentStatus = "submitted" | "confirmed" | "failed";

export interface IntentRecord {
  status: IntentStatus;
  txHash: Hex;
}

/**
 * In-memory idempotency cache, keyed by EIP-712 digest. Replaying the same signed
 * intent returns the original result instead of a doomed second submission. The
 * receipt watcher upgrades records from "submitted" to "confirmed"/"failed", so
 * late replays see the final state.
 *
 * Deliberately volatile (CLAUDE.md: no database, chain is the source of truth):
 * after a restart a replay simply falls through to the on-chain nonce check, which
 * rejects consumed intents anyway — the cache only saves gas and round-trips.
 */
export class IdempotencyCache {
  private readonly records = new Map<Hex, IntentRecord>();

  get(digest: Hex): IntentRecord | undefined {
    return this.records.get(digest);
  }

  set(digest: Hex, record: IntentRecord): void {
    this.records.set(digest, record);
  }

  /** No-op when the digest was never cached (e.g. watcher firing after a restart). */
  updateStatus(digest: Hex, status: IntentStatus): void {
    const record = this.records.get(digest);
    if (record) this.records.set(digest, { ...record, status });
  }

  delete(digest: Hex): void {
    this.records.delete(digest);
  }

  get size(): number {
    return this.records.size;
  }
}

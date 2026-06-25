import { describe, expect, it } from "vitest";
import { IdempotencyCache } from "../src/idempotency.js";

const DIGEST = `0x${"aa".repeat(32)}` as const;
const TX = `0x${"bb".repeat(32)}` as const;

describe("IdempotencyCache", () => {
  it("returns what was stored", () => {
    const cache = new IdempotencyCache();
    expect(cache.get(DIGEST)).toBeUndefined();
    cache.set(DIGEST, { status: "submitted", txHash: TX });
    expect(cache.get(DIGEST)).toEqual({ status: "submitted", txHash: TX });
    expect(cache.size).toBe(1);
  });

  it("upgrades the status in place (receipt watcher path)", () => {
    const cache = new IdempotencyCache();
    cache.set(DIGEST, { status: "submitted", txHash: TX });
    cache.updateStatus(DIGEST, "confirmed");
    expect(cache.get(DIGEST)).toEqual({ status: "confirmed", txHash: TX });
  });

  it("ignores status updates for unknown digests (post-restart watcher)", () => {
    const cache = new IdempotencyCache();
    cache.updateStatus(DIGEST, "confirmed");
    expect(cache.get(DIGEST)).toBeUndefined();
  });

  it("forgets deleted entries (failed-intent retry path)", () => {
    const cache = new IdempotencyCache();
    cache.set(DIGEST, { status: "failed", txHash: TX });
    cache.delete(DIGEST);
    expect(cache.get(DIGEST)).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

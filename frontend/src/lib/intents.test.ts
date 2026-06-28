import { describe, expect, it } from "vitest";
import { authorizationWindow, deadlineIn, randomNonce } from "./intents";

describe("randomNonce", () => {
  it("is a 32-byte hex value", () => expect(randomNonce()).toMatch(/^0x[0-9a-f]{64}$/));
  it("is different each call", () => expect(randomNonce()).not.toBe(randomNonce()));
});

describe("deadlineIn", () => {
  it("returns a future timestamp", () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(deadlineIn(3600)).toBeGreaterThan(now);
  });
});

describe("authorizationWindow", () => {
  it("starts immediately and ends in the future", () => {
    const w = authorizationWindow(3600);
    expect(w.validAfter).toBe(0n);
    expect(w.validBefore).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  });
});

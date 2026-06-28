import { describe, expect, it } from "vitest";
import { bankHealth, isFullyCovered } from "./metrics";

const MAX = 2n ** 256n - 1n;

describe("bankHealth", () => {
  it("is HEALTHY when ratio >= threshold", () => {
    expect(bankHealth(1250n, 1000n, 500_000n)).toBe("HEALTHY");
  });
  it("is HEALTHY with the no-deposits sentinel", () => {
    expect(bankHealth(MAX, 1000n, 0n)).toBe("HEALTHY");
  });
  it("is STRESSED below threshold with reserves", () => {
    expect(bankHealth(800n, 1000n, 1n)).toBe("STRESSED");
  });
  it("is ILLIQUID below threshold with zero reserves", () => {
    expect(bankHealth(0n, 1000n, 0n)).toBe("ILLIQUID");
  });
});

describe("isFullyCovered", () => {
  it("is true at exactly 100%", () => expect(isFullyCovered(10_000n)).toBe(true));
  it("is true above 100%", () => expect(isFullyCovered(12_000n)).toBe(true));
  it("is false below 100%", () => expect(isFullyCovered(9_999n)).toBe(false));
});

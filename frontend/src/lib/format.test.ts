import { describe, expect, it } from "vitest";
import { formatPercentFromBps, isUnboundedRatio, parseAmount } from "./format";

const MAX = 2n ** 256n - 1n;

describe("parseAmount", () => {
  it("applies 6 decimals", () => expect(parseAmount("1")).toBe(1_000_000n));
  it("handles a decimal point", () => expect(parseAmount("1.5")).toBe(1_500_000n));
  it("handles a French comma", () => expect(parseAmount("2,25")).toBe(2_250_000n));
});

describe("formatPercentFromBps", () => {
  it("formats 1250 bps as 12.50 %", () => expect(formatPercentFromBps(1250n)).toBe("12.50 %"));
  it("formats the unbounded sentinel as ∞", () => expect(formatPercentFromBps(MAX)).toBe("∞"));
});

describe("isUnboundedRatio", () => {
  it("flags the max sentinel", () => expect(isUnboundedRatio(MAX)).toBe(true));
  it("does not flag a normal ratio", () => expect(isUnboundedRatio(1250n)).toBe(false));
});

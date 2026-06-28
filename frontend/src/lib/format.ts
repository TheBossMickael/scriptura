import { formatUnits, parseUnits } from "viem";

/** All system tokens use 6 decimals (USDC style). */
export const DECIMALS = 6;
export const BPS_DENOMINATOR = 10_000n;

// Contracts return type(uint256).max for ratios when the denominator is 0 (no deposits /
// no sEUR supply): "trivially covered". Treat anything absurdly large as unbounded.
const RATIO_UNBOUNDED_THRESHOLD = 100_000_000n; // 1,000,000 %

export function isUnboundedRatio(bps: bigint): boolean {
  return bps > RATIO_UNBOUNDED_THRESHOLD;
}

/** Formats a 6-decimals amount with French grouping and up to 2 decimal places. */
export function formatAmount(value: bigint): string {
  const s = formatUnits(value, DECIMALS);
  const [intPart, fracPart] = s.split(".");
  const grouped = BigInt(intPart ?? "0").toLocaleString("fr-FR");
  if (!fracPart) return grouped;
  const trimmed = fracPart.slice(0, 2).replace(/0+$/, "");
  return trimmed ? `${grouped},${trimmed}` : grouped;
}

/** Parses a human amount (e.g. "1500.25") into 6-decimals base units. Throws if malformed. */
export function parseAmount(value: string): bigint {
  return parseUnits(value.trim().replace(",", "."), DECIMALS);
}

/** Like parseAmount but returns undefined on empty/invalid input (for live form validation). */
export function tryParseAmount(value: string): bigint | undefined {
  if (!value.trim()) return undefined;
  try {
    return parseAmount(value);
  } catch {
    return undefined;
  }
}

/** Formats a basis-points ratio as a percentage string ("12.50 %"), or "∞" when unbounded. */
export function formatPercentFromBps(bps: bigint): string {
  if (isUnboundedRatio(bps)) return "∞";
  return `${(Number(bps) / 100).toFixed(2)} %`;
}

/** Truncated address for compact display. */
export function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** True if `s` is a syntactically valid 0x-prefixed 20-byte address. */
export function looksLikeAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

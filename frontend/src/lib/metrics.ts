/**
 * Pure metric helpers derived from on-chain reads (testable, no I/O). Health states follow
 * docs/projet.md §5.5; ILLIQUID is surfaced statically when reserves are exhausted, and
 * reactively when an interbank settlement reverts with InsufficientReserves.
 */

export type Health = "HEALTHY" | "STRESSED" | "ILLIQUID";

export const HEALTH_LABEL: Record<Health, string> = {
  HEALTHY: "Sain",
  STRESSED: "Stressé",
  ILLIQUID: "Illiquide",
};

export const HEALTH_EMOJI: Record<Health, string> = {
  HEALTHY: "🟢",
  STRESSED: "🟠",
  ILLIQUID: "🔴",
};

/**
 * Bank health from its reserve ratio (in bps), the regulatory threshold, and reserves.
 * `ratioBps` may be the type(uint256).max sentinel (no deposits) → trivially HEALTHY.
 */
export function bankHealth(ratioBps: bigint, thresholdBps: bigint, reserves: bigint): Health {
  if (ratioBps >= thresholdBps) return "HEALTHY";
  if (reserves > 0n) return "STRESSED";
  return "ILLIQUID";
}

/** sEUR is fully backed when coverage >= 100% (10_000 bps); the max sentinel means no supply. */
export function isFullyCovered(coverageBps: bigint): boolean {
  return coverageBps >= 10_000n;
}

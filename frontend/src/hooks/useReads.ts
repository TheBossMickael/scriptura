import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { deployment } from "../lib/directory";
import { commercialBankAbi, centralBankAbi, depositTokenAbi, seurAbi, stableCoAbi, wcbdcAbi } from "../lib/abis";

// Slow fallback poll: freshness is driven by useChainWatcher (invalidate on events) and by the
// PendingProvider (invalidate after each confirmed action). This interval only catches a missed
// event, so it stays long to keep RPC noise low.
const POLL = { refetchInterval: 15000 } as const;

/** System-wide monetary aggregates for the macro dashboards (central bank / observer). */
export function useSystemSnapshot() {
  const m0 = useReadContract({ address: deployment.wcbdc, abi: wcbdcAbi, functionName: "totalSupply", query: POLL });
  const thresholdBps = useReadContract({
    address: deployment.centralBank,
    abi: centralBankAbi,
    functionName: "reserveRatioThresholdBps",
    query: POLL,
  });

  const reservesA = useReadContract({
    address: deployment.bankA,
    abi: commercialBankAbi,
    functionName: "reserves",
    query: POLL,
  });
  const ratioA = useReadContract({
    address: deployment.bankA,
    abi: commercialBankAbi,
    functionName: "reserveRatioBps",
    query: POLL,
  });
  const m1A = useReadContract({ address: deployment.depA, abi: depositTokenAbi, functionName: "totalSupply", query: POLL });
  const pausedA = useReadContract({ address: deployment.depA, abi: depositTokenAbi, functionName: "paused", query: POLL });

  const reservesB = useReadContract({
    address: deployment.bankB,
    abi: commercialBankAbi,
    functionName: "reserves",
    query: POLL,
  });
  const ratioB = useReadContract({
    address: deployment.bankB,
    abi: commercialBankAbi,
    functionName: "reserveRatioBps",
    query: POLL,
  });
  const m1B = useReadContract({ address: deployment.depB, abi: depositTokenAbi, functionName: "totalSupply", query: POLL });
  const pausedB = useReadContract({ address: deployment.depB, abi: depositTokenAbi, functionName: "paused", query: POLL });

  const stReserves = useReadContract({
    address: deployment.stableCo,
    abi: stableCoAbi,
    functionName: "reserves",
    query: POLL,
  });
  const coverageBps = useReadContract({
    address: deployment.stableCo,
    abi: stableCoAbi,
    functionName: "coverageRatioBps",
    query: POLL,
  });
  const stPaused = useReadContract({
    address: deployment.stableCo,
    abi: stableCoAbi,
    functionName: "paused",
    query: POLL,
  });
  const seurSupply = useReadContract({
    address: deployment.seur,
    abi: seurAbi,
    functionName: "totalSupply",
    query: POLL,
  });

  return {
    m0: m0.data,
    thresholdBps: thresholdBps.data,
    bankA: { reserves: reservesA.data, ratioBps: ratioA.data, m1: m1A.data, paused: pausedA.data },
    bankB: { reserves: reservesB.data, ratioBps: ratioB.data, m1: m1B.data, paused: pausedB.data },
    stable: {
      reserves: stReserves.data,
      coverageBps: coverageBps.data,
      paused: stPaused.data,
      supply: seurSupply.data,
    },
  };
}

/** DEP + sEUR balances of an account (client view). `dep` is the account's own bank token. */
export function useAccountBalances(account: Address | undefined, depToken: Address | undefined) {
  const dep = useReadContract({
    address: depToken,
    abi: depositTokenAbi,
    functionName: "balanceOf",
    args: account ? ([account] as const) : undefined,
    query: { ...POLL, enabled: Boolean(account && depToken) },
  });
  const seur = useReadContract({
    address: deployment.seur,
    abi: seurAbi,
    functionName: "balanceOf",
    args: account ? ([account] as const) : undefined,
    query: { ...POLL, enabled: Boolean(account) },
  });
  return { dep: dep.data, seur: seur.data };
}

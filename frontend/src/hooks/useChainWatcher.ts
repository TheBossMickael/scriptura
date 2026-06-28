import { useCallback } from "react";
import { useWatchContractEvent } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { deployment } from "../lib/directory";
import { commercialBankAbi, seurAbi, settlementEngineAbi, stableCoAbi } from "../lib/abis";

/**
 * Event-driven freshness: watch the system's contracts and invalidate all reads on any new
 * event, so cross-actor changes (someone else paying, a freeze…) appear instantly. Reads keep
 * a slow fallback poll in case an event is missed. The user's own actions already invalidate
 * on confirmation (PendingProvider). Watching a handful of contracts is lighter on the RPC
 * than polling every read on a short interval.
 */
export function useChainWatcher() {
  const queryClient = useQueryClient();
  const onLogs = useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);
  const onError = useCallback(() => {
    // Swallow transient watcher errors (e.g. RPC hiccups); the fallback poll keeps data fresh.
  }, []);

  useWatchContractEvent({ address: deployment.settlementEngine, abi: settlementEngineAbi, onLogs, onError });
  useWatchContractEvent({ address: deployment.bankA, abi: commercialBankAbi, onLogs, onError });
  useWatchContractEvent({ address: deployment.bankB, abi: commercialBankAbi, onLogs, onError });
  useWatchContractEvent({ address: deployment.stableCo, abi: stableCoAbi, onLogs, onError });
  useWatchContractEvent({ address: deployment.seur, abi: seurAbi, onLogs, onError });
}

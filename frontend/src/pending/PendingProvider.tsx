import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Global action lock (blocking UX): while any action is in flight, `isBusy` is true so every
 * action button across the app is disabled — no bursts, no concurrent intents. Per-action
 * progress/result is shown in-section by `useTx` + `TxStatus` (not a global overlay). On
 * success all reads are invalidated so balances/metrics/role refresh at once.
 */
export interface PendingApi {
  isBusy: boolean;
  /** Runs `fn` with the global lock held; invalidates reads on success; re-throws on failure. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}

const PendingContext = createContext<PendingApi | null>(null);

export function PendingProvider({ children }: { children: ReactNode }) {
  const [busyCount, setBusyCount] = useState(0);
  const queryClient = useQueryClient();

  const run = useCallback<PendingApi["run"]>(
    async (fn) => {
      setBusyCount((n) => n + 1);
      try {
        const result = await fn();
        await queryClient.invalidateQueries();
        return result;
      } finally {
        setBusyCount((n) => n - 1);
      }
    },
    [queryClient],
  );

  const value = useMemo<PendingApi>(() => ({ isBusy: busyCount > 0, run }), [busyCount, run]);
  return <PendingContext.Provider value={value}>{children}</PendingContext.Provider>;
}

export function usePending(): PendingApi {
  const ctx = useContext(PendingContext);
  if (!ctx) throw new Error("usePending must be used within a PendingProvider");
  return ctx;
}

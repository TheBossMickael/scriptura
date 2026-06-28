import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { ponderApi } from "../lib/ponder";

// Slow fallback poll; useChainWatcher invalidates these queries instantly on new events.
const REFRESH = 15000;

export function usePayments(params: { account?: Address; bank?: Address; limit?: number } = {}) {
  return useQuery({ queryKey: ["payments", params], queryFn: () => ponderApi.payments(params), refetchInterval: REFRESH });
}

export function useStableFlows(params: { account?: Address; limit?: number } = {}) {
  return useQuery({
    queryKey: ["stable-flows", params],
    queryFn: () => ponderApi.stableFlows(params),
    refetchInterval: REFRESH,
  });
}

export function useRatioBreaches(params: { bank?: Address; limit?: number } = {}) {
  return useQuery({
    queryKey: ["ratio-breaches", params],
    queryFn: () => ponderApi.ratioBreaches(params),
    refetchInterval: REFRESH,
  });
}

export function useBankStatus(params: { bank?: Address; limit?: number } = {}) {
  return useQuery({
    queryKey: ["bank-status", params],
    queryFn: () => ponderApi.bankStatus(params),
    refetchInterval: REFRESH,
  });
}

export function useClients(params: { bank?: Address; limit?: number } = {}) {
  return useQuery({ queryKey: ["clients", params], queryFn: () => ponderApi.clients(params), refetchInterval: REFRESH });
}

export function useSeurTransfers(params: { account?: Address; limit?: number } = {}) {
  return useQuery({
    queryKey: ["seur-transfers", params],
    queryFn: () => ponderApi.seurTransfers(params),
    refetchInterval: REFRESH,
  });
}

export function useSeurHolders(params: { limit?: number } = {}) {
  return useQuery({
    queryKey: ["seur-holders", params],
    queryFn: () => ponderApi.seurHolders(params),
    refetchInterval: REFRESH,
  });
}

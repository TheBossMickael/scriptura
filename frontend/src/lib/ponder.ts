import type { Address, Hex } from "viem";
import { PONDER_URL } from "./env";

/**
 * Read-only client for the Ponder indexer's custom REST API (indexer/src/api/index.ts).
 * uint256 columns arrive as decimal strings; callers BigInt() them where needed. All data is
 * public — the role only decides which slice a view requests.
 */

export interface PaymentRow {
  id: string;
  kind: "interbank" | "intrabank";
  sender: Address;
  recipient: Address;
  fromBank: Address;
  toBank: Address;
  amount: string;
  blockNumber: string;
  timestamp: string;
  txHash: Hex;
}

export interface StableFlowRow {
  id: string;
  kind: "mint" | "redeem";
  account: Address;
  bank: Address;
  amount: string;
  blockNumber: string;
  timestamp: string;
  txHash: Hex;
}

export interface RatioBreachRow {
  id: string;
  bank: Address;
  ratioBps: string;
  thresholdBps: string;
  blockNumber: string;
  timestamp: string;
  txHash: Hex;
}

export interface BankStatusRow {
  id: string;
  bank: Address;
  frozen: boolean;
  blockNumber: string;
  timestamp: string;
  txHash: Hex;
}

export interface ClientRow {
  bank: Address;
  address: Address;
  active: boolean;
  registeredAt: string;
}

export interface SeurTransferRow {
  id: string;
  sender: Address;
  recipient: Address;
  amount: string;
  blockNumber: string;
  timestamp: string;
  txHash: Hex;
}

export interface SeurHolderRow {
  address: Address;
  balance: string;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${PONDER_URL}${path}`);
  if (!res.ok) throw new Error(`Indexer ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const ponderApi = {
  payments: (params: { account?: Address; bank?: Address; limit?: number } = {}) =>
    get<PaymentRow[]>(`/payments${query(params)}`),
  stableFlows: (params: { account?: Address; limit?: number } = {}) =>
    get<StableFlowRow[]>(`/stable-flows${query(params)}`),
  ratioBreaches: (params: { bank?: Address; limit?: number } = {}) =>
    get<RatioBreachRow[]>(`/ratio-breaches${query(params)}`),
  bankStatus: (params: { bank?: Address; limit?: number } = {}) =>
    get<BankStatusRow[]>(`/bank-status${query(params)}`),
  clients: (params: { bank?: Address; limit?: number } = {}) => get<ClientRow[]>(`/clients${query(params)}`),
  seurTransfers: (params: { account?: Address; limit?: number } = {}) =>
    get<SeurTransferRow[]>(`/seur-transfers${query(params)}`),
  seurHolders: (params: { limit?: number } = {}) => get<SeurHolderRow[]>(`/seur-holders${query(params)}`),
};

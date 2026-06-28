import type { Address, Hex } from "viem";
import { RELAYER_URL } from "./env";
import type { MintIntent, PaymentIntent, RedeemIntent, TransferAuthorization } from "./eip712";
import type { BankKey } from "./directory";

/** Successful relay (the relayer responds at submission; the front confirms on-chain). */
export interface RelayerSuccess {
  digest?: Hex;
  txHash: Hex;
  status: string;
  idempotent?: boolean;
}

export interface HealthResponse {
  status: string;
  chain: string;
  chainId: number;
  relayer: Address;
  engine: Address;
  stableCo: Address;
  seur: Address;
  balance: string;
  funded: boolean;
  cachedIntents: number;
  faucetAmount: string;
}

/** A non-2xx relayer response, carrying the structured error for UX messaging. */
export class RelayerError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly reason?: string;
  readonly args?: string[];

  constructor(httpStatus: number, body: { error?: string; reason?: string; args?: string[] }) {
    super(body.reason ?? body.error ?? `HTTP ${httpStatus}`);
    this.name = "RelayerError";
    this.httpStatus = httpStatus;
    this.code = body.error ?? "unknown_error";
    if (body.reason !== undefined) this.reason = body.reason;
    if (body.args !== undefined) this.args = body.args;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RELAYER_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new RelayerError(0, { error: "network_error" });
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new RelayerError(res.status, data);
  return data as T;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${RELAYER_URL}/health`);
  if (!res.ok) throw new RelayerError(res.status, { error: "health_failed" });
  return (await res.json()) as HealthResponse;
}

export function submitPayment(intent: PaymentIntent, signature: Hex): Promise<RelayerSuccess> {
  return post<RelayerSuccess>("/intent", {
    type: "payment",
    intent: {
      from: intent.from,
      fromBank: intent.fromBank,
      toBank: intent.toBank,
      to: intent.to,
      amount: intent.amount.toString(),
      nonce: intent.nonce.toString(),
      deadline: intent.deadline.toString(),
    },
    signature,
  });
}

export function submitMint(intent: MintIntent, signature: Hex): Promise<RelayerSuccess> {
  return post<RelayerSuccess>("/intent", {
    type: "mint",
    intent: {
      minter: intent.minter,
      minterBank: intent.minterBank,
      amount: intent.amount.toString(),
      nonce: intent.nonce.toString(),
      deadline: intent.deadline.toString(),
    },
    signature,
  });
}

export function submitRedeem(intent: RedeemIntent, signature: Hex): Promise<RelayerSuccess> {
  return post<RelayerSuccess>("/intent", {
    type: "redeem",
    intent: {
      redeemer: intent.redeemer,
      redeemerBank: intent.redeemerBank,
      amount: intent.amount.toString(),
      nonce: intent.nonce.toString(),
      deadline: intent.deadline.toString(),
    },
    signature,
  });
}

export function submitTransfer3009(auth: TransferAuthorization, signature: Hex): Promise<RelayerSuccess> {
  return post<RelayerSuccess>("/intent", {
    type: "transfer3009",
    authorization: {
      from: auth.from,
      to: auth.to,
      value: auth.value.toString(),
      validAfter: auth.validAfter.toString(),
      validBefore: auth.validBefore.toString(),
      nonce: auth.nonce,
    },
    signature,
  });
}

export interface FaucetSuccess {
  status: string;
  txHash: Hex;
  bank: BankKey;
  client: Address;
  amount: string;
}

export function faucet(address: Address, bank: BankKey): Promise<FaucetSuccess> {
  return post<FaucetSuccess>("/faucet", { address, bank });
}

/** Maps a relayer error to a short French message for the UI. */
export function describeRelayerError(error: unknown): string {
  if (!(error instanceof RelayerError)) {
    return error instanceof Error ? error.message : "Erreur inconnue";
  }
  switch (error.code) {
    case "network_error":
      return "Relayer injoignable (le service tourne-t-il ?).";
    case "invalid_request":
      return "Requête invalide.";
    case "invalid_signature":
      return "Signature invalide.";
    case "intent_expired":
      return "Intent expiré, relancez l'opération.";
    case "nonce_mismatch":
      return "Une opération précédente n'est pas encore confirmée — patientez puis réessayez.";
    case "authorization_already_used":
      return "Autorisation déjà utilisée.";
    case "authorization_not_yet_valid":
    case "authorization_expired":
      return "Fenêtre de validité de l'autorisation dépassée.";
    case "onboard_reverted":
      return error.reason === "AlreadyClient"
        ? "Cette adresse est déjà cliente."
        : `Onboarding refusé (${error.reason ?? "raison inconnue"}).`;
    case "execution_reverted":
      return `Transaction rejetée on-chain : ${error.reason ?? "raison inconnue"}.`;
    case "rpc_error":
      return "Erreur RPC côté relayer.";
    case "submission_failed":
      return "Échec de soumission (relayer en manque de gas ?).";
    default:
      return error.message;
  }
}

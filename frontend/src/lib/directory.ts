import { getAddress, keccak256, toBytes, type Address } from "viem";
import rawDeployment from "@deployments/local.json";

/**
 * Typed view of `deployments/<chain>.json` (the deploy output), plus role constants and the
 * actor directory the UI needs for role resolution and friendly labels. Anvil-first: we load
 * local.json; Sepolia wiring (selecting the file by chain) lands at the end of the phase.
 *
 * The committed local.json may be stale (Phase 4 left it without stableCo/seur). A fresh
 * `make deploy-local` regenerates a complete file — `deploymentComplete` flags the gap so the
 * app can show a clear "run the deploy" screen instead of crashing on undefined addresses.
 */
export interface Deployment {
  chainId: number;
  startBlock: number;
  centralBank: Address;
  wcbdc: Address;
  bankA: Address;
  depA: Address;
  bankB: Address;
  depB: Address;
  settlementEngine: Address;
  stableCo: Address;
  seur: Address;
  centralBankOperator: Address;
  bankAOperator: Address;
  bankBOperator: Address;
  stableCoOperator: Address;
  alice1: Address;
  alice2: Address;
  bob1: Address;
  bob2: Address;
  relayer: Address;
}

export const deployment = rawDeployment as unknown as Deployment;

export const expectedChainId = deployment.chainId;
export const startBlock = deployment.startBlock;

/** Contract addresses required for the app to function (checked at boot). */
const REQUIRED_CONTRACTS: (keyof Deployment)[] = [
  "centralBank",
  "wcbdc",
  "bankA",
  "depA",
  "bankB",
  "depB",
  "settlementEngine",
  "stableCo",
  "seur",
];

export const missingContracts = REQUIRED_CONTRACTS.filter((key) => !deployment[key]);
export const deploymentComplete = missingContracts.length === 0;

/** OZ AccessControl role ids: keccak256 of the role's UTF-8 name. */
export const OPERATOR_ROLE = keccak256(toBytes("OPERATOR_ROLE"));
export const FAUCET_ROLE = keccak256(toBytes("FAUCET_ROLE"));

export type BankKey = "A" | "B";

export interface BankInfo {
  key: BankKey;
  label: string;
  bank: Address;
  operator: Address;
  dep: Address;
  depSymbol: string;
}

export const BANKS: Record<BankKey, BankInfo> = {
  A: {
    key: "A",
    label: "Bank A",
    bank: deployment.bankA,
    operator: deployment.bankAOperator,
    dep: deployment.depA,
    depSymbol: "DEP-A",
  },
  B: {
    key: "B",
    label: "Bank B",
    bank: deployment.bankB,
    operator: deployment.bankBOperator,
    dep: deployment.depB,
    depSymbol: "DEP-B",
  },
};

/** Friendly labels for the known genesis actors (by lowercased address). */
const ACTOR_LABELS: Record<string, string> = {};
function label(addr: Address | undefined, name: string): void {
  if (addr) ACTOR_LABELS[addr.toLowerCase()] = name;
}
label(deployment.centralBankOperator, "Central bank (operator)");
label(deployment.bankAOperator, "Bank A operator");
label(deployment.bankBOperator, "Bank B operator");
label(deployment.stableCoOperator, "StableCo operator");
label(deployment.alice1, "Alice 1");
label(deployment.alice2, "Alice 2");
label(deployment.bob1, "Bob 1");
label(deployment.bob2, "Bob 2");
label(deployment.relayer, "Relayer");
label(deployment.stableCo, "StableCo");
label(deployment.bankA, "Bank A");
label(deployment.bankB, "Bank B");

export interface KnownClient {
  address: Address;
  label: string;
  bankKey: BankKey;
}

/** The genesis client EOAs, for recipient pickers (self-onboarded clients use manual entry). */
export const CLIENTS: KnownClient[] = [
  { address: deployment.alice1, label: "Alice 1 (Bank A)", bankKey: "A" },
  { address: deployment.alice2, label: "Alice 2 (Bank A)", bankKey: "A" },
  { address: deployment.bob1, label: "Bob 1 (Bank B)", bankKey: "B" },
  { address: deployment.bob2, label: "Bob 2 (Bank B)", bankKey: "B" },
];

/** A short, human label for an address (named actor, or truncated 0x…). */
export function labelForAddress(value: string | undefined): string {
  if (!value) return "—";
  const named = ACTOR_LABELS[value.toLowerCase()];
  if (named) return named;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Bank a known address belongs to as operator, if any (for labeling / lookups). */
export function bankByAddress(value: Address): BankInfo | undefined {
  const lower = value.toLowerCase();
  if (deployment.bankA.toLowerCase() === lower) return BANKS.A;
  if (deployment.bankB.toLowerCase() === lower) return BANKS.B;
  return undefined;
}

/** Normalizes an address to its checksum form (throws on malformed input). */
export function normalize(value: string): Address {
  return getAddress(value);
}

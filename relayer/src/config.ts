import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, parseEther, parseUnits, type Address, type Hex } from "viem";
import { z } from "zod";

export type ChainName = "local" | "sepolia";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "invalid address")
  .transform((s) => getAddress(s.toLowerCase()) as Address);

/// Subset of deployments/<chain>.json the relayer consumes. Written by Deploy.s.sol;
/// extra keys (actor directory for the Phase 5 frontend) pass through untouched.
const deploymentsSchema = z.looseObject({
  chainId: z.number().int().positive(),
  startBlock: z.number().int().nonnegative(),
  settlementEngine: address,
  stableCo: address,
  seur: address,
  bankA: address,
  bankB: address,
  depA: address,
  depB: address,
  relayer: address,
});

export type Deployments = z.infer<typeof deploymentsSchema>;

export interface Config {
  chain: ChainName;
  rpcUrl: string;
  /** The relayer's own private key — the ONLY key this service holds (gas-only EOA). */
  relayerPk: Hex;
  port: number;
  /** Alert threshold for the relayer's gas balance, in wei. */
  minRelayerBalance: bigint;
  fundCheckIntervalMs: number;
  /** Test deposits credited per Option B faucet onboarding, in 6-decimals units. */
  faucetAmount: bigint;
  deployments: Deployments;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Builds the runtime configuration from the environment and the committed
 * deployments file. No database, no state: everything is env + chain (CLAUDE.md).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // CHAIN_NAME, not CHAIN: foundry binaries auto-load .env and bind CHAIN to their
  // --chain flag, so the project-wide variable must not collide with it.
  const chain = env.CHAIN_NAME ?? "local";
  if (chain !== "local" && chain !== "sepolia") {
    throw new Error(`Unsupported CHAIN_NAME "${chain}" — expected "local" or "sepolia"`);
  }

  // RPC_URL always wins; otherwise local falls back to the Anvil default and sepolia
  // requires an explicit SEPOLIA_RPC_URL.
  const rpcUrl =
    env.RPC_URL ?? (chain === "sepolia" ? env.SEPOLIA_RPC_URL : "http://127.0.0.1:8545");
  if (!rpcUrl) {
    throw new Error("SEPOLIA_RPC_URL (or RPC_URL) is required when CHAIN=sepolia");
  }

  // The relayer holds exactly one private key — its own, gas-only EOA. No mnemonic:
  // it must never be able to derive (and thus impersonate) the clients' keys.
  const relayerPk = env.RELAYER_PK;
  if (!relayerPk || !/^0x[0-9a-fA-F]{64}$/.test(relayerPk)) {
    throw new Error("RELAYER_PK is required (0x-prefixed 32-byte hex private key)");
  }

  const deploymentsDir = env.DEPLOYMENTS_DIR ?? resolve(here, "..", "..", "deployments");
  const deploymentsFile = resolve(deploymentsDir, `${chain}.json`);
  let deployments: Deployments;
  try {
    deployments = deploymentsSchema.parse(JSON.parse(readFileSync(deploymentsFile, "utf8")));
  } catch (cause) {
    throw new Error(`Cannot load deployments file ${deploymentsFile} — run the deploy script first`, { cause });
  }

  return {
    chain,
    rpcUrl,
    relayerPk: relayerPk as Hex,
    port: Number(env.RELAYER_PORT ?? 3001),
    minRelayerBalance: parseEther(env.MIN_RELAYER_BALANCE ?? "0.02"),
    fundCheckIntervalMs: Number(env.FUND_CHECK_INTERVAL_MS ?? 60_000),
    // Whole test euros per onboard (default 100k), capped on-chain by MAX_FAUCET_CREDIT.
    faucetAmount: parseUnits(env.FAUCET_AMOUNT ?? "100000", 6),
    deployments,
  };
}

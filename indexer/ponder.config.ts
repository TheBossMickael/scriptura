import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "ponder";
import { commercialBankAbi, seurAbi, settlementEngineAbi, stableCoAbi } from "./abis";
import type { Deployments } from "./deployments";

const here = dirname(fileURLToPath(import.meta.url));

// Same convention as the relayer (relayer/src/config.ts): CHAIN_NAME selects which committed
// deployments file to read. The chain is the source of truth — the indexer reads addresses
// and startBlock from there, never hardcodes them.
const chainName = process.env.CHAIN_NAME ?? "local";
const deploymentsDir = process.env.DEPLOYMENTS_DIR ?? resolve(here, "..", "deployments");
const deployment = JSON.parse(
  readFileSync(resolve(deploymentsDir, `${chainName}.json`), "utf8"),
) as Deployments;

// PONDER_RPC_URL wins (comma-separated list = failover pool, rotated by Ponder when one
// endpoint throttles); otherwise RPC_URL; local falls back to the Anvil default. NOTE: never
// point the indexer at an Alchemy Free endpoint — that plan caps eth_getLogs at a 10-block
// range, which structurally floods the backfill (see .env.example for validated endpoints).
const rpcEnv =
  process.env.PONDER_RPC_URL ??
  process.env.RPC_URL ??
  (chainName === "sepolia" ? process.env.SEPOLIA_RPC_URL : "http://127.0.0.1:8545");

if (!rpcEnv) {
  throw new Error("PONDER_RPC_URL (or RPC_URL / SEPOLIA_RPC_URL) is required when CHAIN_NAME=sepolia");
}
const rpc = rpcEnv.split(",").map((url) => url.trim()).filter(Boolean);

// Every source shares the same deploy block — no event predates the genesis deploy (trap #6).
const startBlock = deployment.startBlock;

export default createConfig({
  chains: {
    [chainName]: {
      id: deployment.chainId,
      rpc,
      // Sparse-event contracts: fetch logs in a wide fixed range so a backfill costs a handful
      // of eth_getLogs (≈ one per filter per 1000 blocks) instead of thousands. Requires a
      // provider accepting wide ranges (drpc / tenderly public gateways, validated 2026-07-01;
      // Alchemy Free hard-caps at 10 blocks → 400s, then Ponder shrinks the range and floods).
      ethGetLogsBlockRange: 1000,
      // Realtime head-polling: Ponder's 1s default is sized for a local Anvil. Sepolia mines a
      // block every ~12s, so 1s polling burns ~86k requests/day on a rate-limited endpoint for
      // nothing; 15s trades ~one block of indexing latency for a ~15x cut in steady RPC load.
      pollingInterval: chainName === "sepolia" ? 15_000 : 1_000,
    },
  },
  contracts: {
    SettlementEngine: {
      chain: chainName,
      abi: settlementEngineAbi,
      address: deployment.settlementEngine,
      startBlock,
    },
    BankA: {
      chain: chainName,
      abi: commercialBankAbi,
      address: deployment.bankA,
      startBlock,
    },
    BankB: {
      chain: chainName,
      abi: commercialBankAbi,
      address: deployment.bankB,
      startBlock,
    },
    StableCo: {
      chain: chainName,
      abi: stableCoAbi,
      address: deployment.stableCo,
      startBlock,
    },
    SEUR: {
      chain: chainName,
      abi: seurAbi,
      address: deployment.seur,
      startBlock,
    },
  },
});

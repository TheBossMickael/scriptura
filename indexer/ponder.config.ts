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

// RPC_URL wins; otherwise local falls back to the Anvil default, sepolia needs SEPOLIA_RPC_URL.
const rpc =
  process.env.PONDER_RPC_URL ??
  process.env.RPC_URL ??
  (chainName === "sepolia" ? process.env.SEPOLIA_RPC_URL : "http://127.0.0.1:8545");

if (!rpc) {
  throw new Error("SEPOLIA_RPC_URL (or RPC_URL / PONDER_RPC_URL) is required when CHAIN_NAME=sepolia");
}

// Every source shares the same deploy block — no event predates the genesis deploy (trap #6).
const startBlock = deployment.startBlock;

export default createConfig({
  chains: {
    [chainName]: { id: deployment.chainId, rpc },
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

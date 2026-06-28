import type { Address } from "viem";

/**
 * Shape of `deployments/<chain>.json` (written by `contracts/script/Deploy.s.sol`). Local to
 * this project — the relayer and frontend each declare their own view of the same file. Only
 * the fields the indexer needs (addresses + chainId + startBlock) are read at runtime.
 */
export interface Deployments {
  chainId: number;
  startBlock: number;
  settlementEngine: Address;
  bankA: Address;
  bankB: Address;
  stableCo: Address;
  seur: Address;
}

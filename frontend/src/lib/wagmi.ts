import { createConfig, http } from "wagmi";
import { anvil, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import type { Hex } from "viem";
import { expectedChainId } from "./directory";

/**
 * wagmi v2 config. Both supported chains are declared (so chain ids stay literal for wagmi's
 * types); the app's "expected" network is `targetChain`, derived from the deployment chainId.
 * The wallet is the injected MetaMask provider. `http()` with no URL uses each chain's default
 * RPC (Anvil: 127.0.0.1:8545).
 */
export const wagmiConfig = createConfig({
  chains: [anvil, sepolia],
  connectors: [injected()],
  transports: {
    [anvil.id]: http(),
    [sepolia.id]: http(),
  },
});

/** The chain matching the committed deployment (Anvil locally, Sepolia for the live demo). */
export const targetChain = expectedChainId === sepolia.id ? sepolia : anvil;

/** Block-explorer URL for a tx, or undefined on chains without an explorer (e.g. Anvil). */
export function explorerTxUrl(hash: Hex): string | undefined {
  const base = targetChain.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : undefined;
}

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

import { createConfig, http } from "wagmi";
import { anvil, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import type { Hex } from "viem";
import { expectedChainId } from "./directory";

/** The chain matching the committed deployment (Anvil locally, Sepolia for the live demo). */
export const targetChain = expectedChainId === sepolia.id ? sepolia : anvil;
const otherChain = targetChain.id === sepolia.id ? anvil : sepolia;

/**
 * wagmi v2 config. Both supported chains are declared (so chain ids stay literal for wagmi's
 * types), but the deployment's chain is listed FIRST: reads without a connected wallet (the
 * read-only explorer / observer) default to `chains[0]`, so it must be the target chain —
 * otherwise they hit the wrong RPC (locally this was harmless since chains[0] was Anvil; on
 * Sepolia it refuses on 127.0.0.1:8545). The wallet is the injected MetaMask provider.
 * `http()` with no URL uses each chain's default public RPC (Anvil: 127.0.0.1:8545).
 */
export const wagmiConfig = createConfig({
  chains: [targetChain, otherChain],
  connectors: [injected()],
  // Reads must ALWAYS target the deployment's chain: without this, connecting a wallet that
  // sits on another network (mainnet, a stale Anvil…) silently re-routes every useReadContract
  // to that network and the whole UI shows loading skeletons. Writes assert their chainId
  // explicitly instead (useActions / BankOperatorView), and the Header banner reads the
  // wallet's real chain from useAccount(), so both keep working with the sync disabled.
  syncConnectedChain: false,
  // Sepolia mines a block every ~12s: the 4s default would fire the 5 event watchers'
  // eth_getLogs three times per block for nothing. Local Anvil keeps the snappy default.
  pollingInterval: targetChain.id === sepolia.id ? 12_000 : 4_000,
  transports: {
    [anvil.id]: http(),
    // batch folds simultaneous JSON-RPC calls (the ~14-read system snapshot, the watchers)
    // into single HTTP requests — an order of magnitude fewer hits on a rate-limited public
    // endpoint. VITE_SEPOLIA_RPC_URL optionally replaces viem's default public RPC; fine for
    // a local demo, but never publish a build embedding a key you care about.
    [sepolia.id]: http(import.meta.env.VITE_SEPOLIA_RPC_URL || undefined, { batch: true }),
  },
});

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

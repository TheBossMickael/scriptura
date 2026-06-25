import {
  createPublicClient,
  createWalletClient,
  http,
  nonceManager,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { anvil, sepolia } from "viem/chains";
import type { Config } from "./config.js";

export interface ChainContext {
  chain: Chain;
  account: PrivateKeyAccount;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

/**
 * Builds the viem clients around the relayer account, derived from its own private key
 * alone (no mnemonic — it must not be able to impersonate clients). The account carries
 * viem's nonceManager: it initializes from the RPC's PENDING transaction count and then
 * increments locally — trap #5 (in-flight transactions surviving a relayer restart are
 * accounted for at boot).
 */
export function createChainContext(cfg: Config): ChainContext {
  const chain = cfg.chain === "sepolia" ? sepolia : anvil;
  const account = privateKeyToAccount(cfg.relayerPk, { nonceManager });
  const transport = http(cfg.rpcUrl);
  return {
    chain,
    account,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account, chain, transport }),
  };
}

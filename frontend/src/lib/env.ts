/**
 * Service URLs. Defaults target the local dev stack (relayer on 3001, Ponder on 42069).
 * Override with VITE_RELAYER_URL / VITE_PONDER_URL at build time. The app is not publicly
 * hosted — the demo runs locally, pointing at Anvil or Sepolia.
 */
export const RELAYER_URL = import.meta.env.VITE_RELAYER_URL ?? "http://localhost:3001";
export const PONDER_URL = import.meta.env.VITE_PONDER_URL ?? "http://localhost:42069";

/** External Sepolia sETH faucet — only needed for the direct (non-gasless) sEUR transfer. */
export const SEPOLIA_ETH_FAUCET_URL = "https://www.alchemy.com/faucets/ethereum-sepolia";

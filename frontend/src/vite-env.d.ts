/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Which committed deployments/<chain>.json the app loads: local | sepolia (default local). */
  readonly VITE_CHAIN?: string;
  /** Optional RPC for browser-side Sepolia reads (defaults to viem's public RPC). */
  readonly VITE_SEPOLIA_RPC_URL?: string;
  readonly VITE_RELAYER_URL?: string;
  readonly VITE_PONDER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

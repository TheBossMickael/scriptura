import cors from "@fastify/cors";
import Fastify from "fastify";
import { createChainContext } from "./chain.js";
import { loadConfig } from "./config.js";
import { checkFunds, describeFunds, startFundWatcher } from "./fundCheck.js";
import { IdempotencyCache } from "./idempotency.js";
import { registerRoutes } from "./routes.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const chain = createChainContext(cfg);
  const cache = new IdempotencyCache();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true }); // Phase 5 frontend talks to us from the browser

  // ---- Boot sanity checks: stateless means everything is re-derived right here ----

  const rpcChainId = await chain.publicClient.getChainId();
  if (rpcChainId !== cfg.deployments.chainId) {
    throw new Error(
      `Chain mismatch: RPC reports chainId ${rpcChainId} but deployments/${cfg.chain}.json says ${cfg.deployments.chainId}`,
    );
  }

  if (chain.account.address !== cfg.deployments.relayer) {
    throw new Error(
      `Relayer EOA mismatch: RELAYER_PK derives ${chain.account.address} but the deployment expects ${cfg.deployments.relayer} — RELAYER_PK and RELAYER_ADDRESS out of sync?`,
    );
  }

  // Trap #5: resync our own EOA nonce from the RPC's PENDING count — transactions
  // in flight from before a shutdown must not be double-spent. viem's nonceManager
  // (attached to the account) sources the same pending count before the first send;
  // this explicit read makes the resync observable in the logs.
  const pendingNonce = await chain.publicClient.getTransactionCount({
    address: chain.account.address,
    blockTag: "pending",
  });
  app.log.info(`relayer ${chain.account.address} resynced at pending nonce ${pendingNonce} (chain ${rpcChainId})`);

  // Initial fund check (loud), then the periodic watcher.
  const fund = await checkFunds(chain.publicClient, chain.account.address, cfg.minRelayerBalance);
  if (fund.funded) {
    app.log.info(describeFunds(fund));
  } else {
    app.log.warn(describeFunds(fund));
  }
  startFundWatcher(
    chain.publicClient,
    chain.account.address,
    cfg.minRelayerBalance,
    cfg.fundCheckIntervalMs,
    app.log,
  );

  registerRoutes(app, { cfg, chain, cache });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: "0.0.0.0", port: cfg.port });
  app.log.info(`POST /intent ready — engine ${cfg.deployments.settlementEngine} on ${cfg.chain}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

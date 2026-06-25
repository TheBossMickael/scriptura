import type { FastifyInstance } from "fastify";
import { BaseError, ContractFunctionRevertedError, verifyTypedData, type Hex } from "viem";
import { settlementEngineAbi } from "./abi.js";
import type { ChainContext } from "./chain.js";
import type { Config } from "./config.js";
import { checkFunds } from "./fundCheck.js";
import type { IdempotencyCache } from "./idempotency.js";
import { intentDigest, intentDomain, intentRequestSchema, PAYMENT_INTENT_TYPES } from "./intent.js";

export interface RouteContext {
  cfg: Config;
  chain: ChainContext;
  cache: IdempotencyCache;
}

interface DecodedRevert {
  errorName: string;
  args: string[];
}

/** Pulls the custom-error name out of a viem simulation failure, if any. */
function decodeRevert(error: unknown): DecodedRevert | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError) || !revert.data) return undefined;
  return {
    errorName: revert.data.errorName,
    args: (revert.data.args ?? []).map(String),
  };
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { cfg, cache } = ctx;
  const { publicClient, walletClient, account } = ctx.chain;
  const engine = cfg.deployments.settlementEngine;
  const chainId = cfg.deployments.chainId;
  const domain = intentDomain(chainId, engine);

  // One transaction in flight at a time: submissions are chained on this promise so
  // two intents can never race for the same relayer nonce (belt to the nonceManager's
  // suspenders). Failures don't break the chain.
  let sendQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = sendQueue.then(task, task);
    sendQueue = run.catch(() => {});
    return run;
  };

  // Fire-and-forget receipt watcher: upgrades the cache entry so replayed POSTs see
  // the final state instead of "submitted". Best-effort by design — on timeout or
  // RPC error the record simply stays "submitted" (the chain remains the truth).
  const watchReceipt = (digest: Hex, txHash: Hex): void => {
    void publicClient
      .waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
      .then((receipt) => cache.updateStatus(digest, receipt.status === "success" ? "confirmed" : "failed"))
      .catch((error: unknown) => {
        app.log.warn(`receipt watch for ${txHash} gave up: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  /**
   * Liveness + fund status. Non-business endpoint (Docker healthcheck, ops):
   * the single business endpoint remains POST /intent.
   */
  app.get("/health", async () => {
    const fund = await checkFunds(publicClient, account.address, cfg.minRelayerBalance);
    return {
      status: "ok",
      chain: cfg.chain,
      chainId,
      relayer: account.address,
      engine,
      balance: fund.balance.toString(),
      funded: fund.funded,
      cachedIntents: cache.size,
    };
  });

  /**
   * The single business endpoint: accepts a client-signed message and relays it.
   * Every check before the submission exists to avoid wasting gas on doomed
   * transactions — authorization lives on-chain only (trap #7).
   */
  app.post("/intent", async (request, reply) => {
    const parsed = intentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    // Discriminated union: "payment" is the only member in Phase 3 (Phase 4 adds
    // the sEUR kinds), so no switch on parsed.data.type yet.
    const { intent, signature } = parsed.data;

    const digest = intentDigest(chainId, engine, intent);

    // Idempotency: the same signed intent returns its original (possibly upgraded)
    // result. A "failed" record never blocks a retry — the on-chain nonce was not
    // consumed by a reverted transaction, so the intent is still executable.
    const cached = cache.get(digest);
    if (cached && cached.status !== "failed") {
      return reply.code(200).send({ digest, ...cached, idempotent: true });
    }
    if (cached) cache.delete(digest);

    // Pre-check 1 — signature, verified locally (no RPC round-trip). verifyTypedData
    // THROWS on malformed signature bytes (e.g. invalid v/yParity) instead of
    // returning false, so the failure mode is folded into "invalid".
    let validSignature = false;
    try {
      validSignature = await verifyTypedData({
        address: intent.from,
        domain,
        types: PAYMENT_INTENT_TYPES,
        primaryType: "PaymentIntent",
        message: intent,
        signature,
      });
    } catch {
      // fall through with validSignature = false
    }
    if (!validSignature) {
      return reply.code(400).send({ error: "invalid_signature", digest });
    }

    // Pre-check 2 — deadline against wall-clock time (advisory; chain time decides).
    if (BigInt(Math.floor(Date.now() / 1000)) > intent.deadline) {
      return reply.code(400).send({ error: "intent_expired", digest, deadline: intent.deadline.toString() });
    }

    // Pre-check 3 — sequential nonce must match the engine's counter exactly.
    let currentNonce: bigint;
    try {
      currentNonce = await publicClient.readContract({
        address: engine,
        abi: settlementEngineAbi,
        functionName: "nonces",
        args: [intent.from],
      });
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: "rpc_error", digest });
    }
    if (intent.nonce !== currentNonce) {
      return reply.code(409).send({
        error: "nonce_mismatch",
        digest,
        intentNonce: intent.nonce.toString(),
        expectedNonce: currentNonce.toString(),
      });
    }

    // Pre-check 4 — full simulation: catches every business revert (client registry,
    // insufficient reserves, frozen bank, ...) and names it via the custom error.
    let simulation;
    try {
      simulation = await publicClient.simulateContract({
        account,
        address: engine,
        abi: settlementEngineAbi,
        functionName: "executeIntent",
        args: [intent, signature],
      });
    } catch (error) {
      const revert = decodeRevert(error);
      if (revert) {
        const status = revert.errorName === "InvalidAccountNonce" ? 409 : 400;
        return reply.code(status).send({ error: "execution_reverted", reason: revert.errorName, args: revert.args, digest });
      }
      request.log.error(error);
      return reply.code(502).send({ error: "rpc_error", digest });
    }

    // Submission — serialized, cached, watched; the response does not wait for the
    // receipt (the frontend tracks "confirmé" from the chain, projet.md §7).
    try {
      const txHash = await enqueue(() => walletClient.writeContract(simulation.request));
      cache.set(digest, { status: "submitted", txHash });
      watchReceipt(digest, txHash);
      return reply.code(200).send({ digest, txHash, status: "submitted" });
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: "submission_failed", digest });
    }
  });
}

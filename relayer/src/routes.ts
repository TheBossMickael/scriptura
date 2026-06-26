import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  BaseError,
  ContractFunctionRevertedError,
  verifyTypedData,
  type Abi,
  type Address,
  type Hex,
  type TypedData,
  type TypedDataDomain,
} from "viem";
import { commercialBankAbi, seurAbi, settlementEngineAbi, stableCoAbi } from "./abi.js";
import type { ChainContext } from "./chain.js";
import type { Config } from "./config.js";
import { checkFunds } from "./fundCheck.js";
import type { IdempotencyCache } from "./idempotency.js";
import {
  authorizationDigest,
  faucetRequestSchema,
  intentDigest,
  intentDomain,
  intentRequestSchema,
  MINT_INTENT_TYPES,
  mintDigest,
  PAYMENT_INTENT_TYPES,
  redeemDigest,
  REDEEM_INTENT_TYPES,
  seurDomain,
  stableCoDomain,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "./intent.js";

export interface RouteContext {
  cfg: Config;
  chain: ChainContext;
  cache: IdempotencyCache;
}

interface DecodedRevert {
  errorName: string;
  args: string[];
}

/** A contract write the relayer simulates then submits. */
interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** A client-signed, sequentially-nonced intent (payment / mint / redeem). */
interface SequentialIntentJob {
  digest: Hex;
  signer: Address;
  domain: TypedDataDomain;
  types: TypedData;
  primaryType: string;
  message: Record<string, unknown>;
  signature: Hex;
  deadline: bigint;
  nonceContract: Address;
  nonceAbi: Abi;
  intentNonce: bigint;
  call: ContractCall;
}

// Reverts that mean "already consumed / out of order" → 409 rather than 400, so a client
// distinguishes a retryable conflict from a malformed request.
const NONCE_CONFLICT_ERRORS = new Set(["InvalidAccountNonce", "AuthorizationAlreadyUsed"]);

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

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { cfg, cache } = ctx;
  const { publicClient, walletClient, account } = ctx.chain;
  const engine = cfg.deployments.settlementEngine;
  const stableCo = cfg.deployments.stableCo;
  const seur = cfg.deployments.seur;
  const chainId = cfg.deployments.chainId;

  // One transaction in flight at a time: submissions are chained on this promise so two
  // intents can never race for the same relayer nonce (belt to the nonceManager's
  // suspenders). Failures don't break the chain.
  let sendQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = sendQueue.then(task, task);
    sendQueue = run.catch(() => {});
    return run;
  };

  // Fire-and-forget receipt watcher: upgrades the cache entry so replayed POSTs see the
  // final state instead of "submitted". Best-effort by design.
  const watchReceipt = (digest: Hex, txHash: Hex): void => {
    void publicClient
      .waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
      .then((receipt) => cache.updateStatus(digest, receipt.status === "success" ? "confirmed" : "failed"))
      .catch((error: unknown) => {
        app.log.warn(`receipt watch for ${txHash} gave up: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  /** Idempotency: replay a prior (possibly upgraded) result; a "failed" record never blocks
   *  a retry (its on-chain nonce was not consumed by a reverted tx). Returns true if served. */
  function respondIfCached(reply: FastifyReply, digest: Hex): boolean {
    const cached = cache.get(digest);
    if (cached && cached.status !== "failed") {
      reply.code(200).send({ digest, ...cached, idempotent: true });
      return true;
    }
    if (cached) cache.delete(digest);
    return false;
  }

  /** Shared tail — simulate (decode business reverts), then serialized submit + watch. */
  async function submit(request: FastifyRequest, reply: FastifyReply, digest: Hex, call: ContractCall) {
    let simulation;
    try {
      simulation = await publicClient.simulateContract({
        account,
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
      });
    } catch (error) {
      const revert = decodeRevert(error);
      if (revert) {
        const status = NONCE_CONFLICT_ERRORS.has(revert.errorName) ? 409 : 400;
        return reply
          .code(status)
          .send({ error: "execution_reverted", reason: revert.errorName, args: revert.args, digest });
      }
      request.log.error(error);
      return reply.code(502).send({ error: "rpc_error", digest });
    }

    try {
      const txHash = await enqueue(() => walletClient.writeContract(simulation.request));
      cache.set(digest, { status: "submitted", txHash });
      watchReceipt(digest, txHash);
      return reply.code(200).send({ digest, txHash, status: "submitted" });
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: "submission_failed", digest });
    }
  }

  /** Pipeline for a sequentially-nonced intent: idempotency → signature → deadline → nonce
   *  → submit. Shared by payment, mint and redeem (structurally identical). */
  async function handleSequentialIntent(request: FastifyRequest, reply: FastifyReply, job: SequentialIntentJob) {
    if (respondIfCached(reply, job.digest)) return;

    // Pre-check 1 — signature, verified locally (verifyTypedData THROWS on malformed bytes).
    let validSignature = false;
    try {
      validSignature = await verifyTypedData({
        address: job.signer,
        domain: job.domain,
        types: job.types,
        primaryType: job.primaryType,
        message: job.message,
        signature: job.signature,
      });
    } catch {
      // fall through with validSignature = false
    }
    if (!validSignature) return reply.code(400).send({ error: "invalid_signature", digest: job.digest });

    // Pre-check 2 — deadline against wall-clock time (advisory; chain time decides).
    if (nowSeconds() > job.deadline) {
      return reply.code(400).send({ error: "intent_expired", digest: job.digest, deadline: job.deadline.toString() });
    }

    // Pre-check 3 — sequential nonce must match the issuing contract's counter exactly.
    let currentNonce: bigint;
    try {
      currentNonce = (await publicClient.readContract({
        address: job.nonceContract,
        abi: job.nonceAbi,
        functionName: "nonces",
        args: [job.signer],
      })) as bigint;
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: "rpc_error", digest: job.digest });
    }
    if (job.intentNonce !== currentNonce) {
      return reply.code(409).send({
        error: "nonce_mismatch",
        digest: job.digest,
        intentNonce: job.intentNonce.toString(),
        expectedNonce: currentNonce.toString(),
      });
    }

    return submit(request, reply, job.digest, job.call);
  }

  /**
   * Liveness + fund status. Non-business endpoint (Docker healthcheck, ops): the single
   * business endpoint remains POST /intent.
   */
  app.get("/health", async () => {
    const fund = await checkFunds(publicClient, account.address, cfg.minRelayerBalance);
    return {
      status: "ok",
      chain: cfg.chain,
      chainId,
      relayer: account.address,
      engine,
      stableCo,
      seur,
      balance: fund.balance.toString(),
      funded: fund.funded,
      cachedIntents: cache.size,
      faucetAmount: cfg.faucetAmount.toString(),
    };
  });

  /**
   * Option B public onboarding. A visitor's address + chosen bank → the relayer calls
   * `CommercialBank.onboard` with its narrow FAUCET_ROLE (register + capped credit). No
   * client signature: the role is the authority, the amount is capped on-chain, and the
   * one-shot-per-address guard limits each wallet to a single onboarding. Shares the
   * relayer's send queue with /intent so both never race for the relayer nonce.
   */
  app.post("/faucet", async (request, reply) => {
    const parsed = faucetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const { address: client, bank } = parsed.data;
    const bankAddress = bank === "A" ? cfg.deployments.bankA : cfg.deployments.bankB;

    // Simulate — catches AlreadyClient (one-shot → 409), frozen bank, missing role.
    let simulation;
    try {
      simulation = await publicClient.simulateContract({
        account,
        address: bankAddress,
        abi: commercialBankAbi,
        functionName: "onboard",
        args: [client, cfg.faucetAmount],
      });
    } catch (error) {
      const revert = decodeRevert(error);
      if (revert) {
        const status = revert.errorName === "AlreadyClient" ? 409 : 400;
        return reply.code(status).send({ error: "onboard_reverted", reason: revert.errorName, args: revert.args });
      }
      request.log.error(error);
      return reply.code(502).send({ error: "rpc_error" });
    }

    try {
      const txHash = await enqueue(() => walletClient.writeContract(simulation.request));
      return reply.code(200).send({ status: "submitted", txHash, bank, client, amount: cfg.faucetAmount.toString() });
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: "submission_failed" });
    }
  });

  /**
   * The single business endpoint: accepts a client-signed message and relays it. Every
   * check before submission exists only to avoid wasting gas on doomed transactions —
   * authorization lives on-chain (trap #7). The discriminated union routes the four kinds:
   * payments (engine), sEUR mint/redeem (StableCo), and gasless sEUR P2P (EIP-3009).
   */
  app.post("/intent", async (request, reply) => {
    const parsed = intentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const body = parsed.data;

    switch (body.type) {
      case "payment": {
        const intent = body.intent;
        return handleSequentialIntent(request, reply, {
          digest: intentDigest(chainId, engine, intent),
          signer: intent.from,
          domain: intentDomain(chainId, engine),
          types: PAYMENT_INTENT_TYPES as unknown as TypedData,
          primaryType: "PaymentIntent",
          message: intent as unknown as Record<string, unknown>,
          signature: body.signature,
          deadline: intent.deadline,
          nonceContract: engine,
          nonceAbi: settlementEngineAbi,
          intentNonce: intent.nonce,
          call: { address: engine, abi: settlementEngineAbi, functionName: "executeIntent", args: [intent, body.signature] },
        });
      }

      case "mint": {
        const intent = body.intent;
        return handleSequentialIntent(request, reply, {
          digest: mintDigest(chainId, stableCo, intent),
          signer: intent.minter,
          domain: stableCoDomain(chainId, stableCo),
          types: MINT_INTENT_TYPES as unknown as TypedData,
          primaryType: "MintIntent",
          message: intent as unknown as Record<string, unknown>,
          signature: body.signature,
          deadline: intent.deadline,
          nonceContract: stableCo,
          nonceAbi: stableCoAbi,
          intentNonce: intent.nonce,
          call: { address: stableCo, abi: stableCoAbi, functionName: "mintFromIntent", args: [intent, body.signature] },
        });
      }

      case "redeem": {
        const intent = body.intent;
        return handleSequentialIntent(request, reply, {
          digest: redeemDigest(chainId, stableCo, intent),
          signer: intent.redeemer,
          domain: stableCoDomain(chainId, stableCo),
          types: REDEEM_INTENT_TYPES as unknown as TypedData,
          primaryType: "RedeemIntent",
          message: intent as unknown as Record<string, unknown>,
          signature: body.signature,
          deadline: intent.deadline,
          nonceContract: stableCo,
          nonceAbi: stableCoAbi,
          intentNonce: intent.nonce,
          call: { address: stableCo, abi: stableCoAbi, functionName: "redeemFromIntent", args: [intent, body.signature] },
        });
      }

      case "transfer3009": {
        const auth = body.authorization;
        const digest = authorizationDigest(chainId, seur, auth);
        if (respondIfCached(reply, digest)) return;

        let validSignature = false;
        try {
          validSignature = await verifyTypedData({
            address: auth.from,
            domain: seurDomain(chainId, seur),
            types: TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as TypedData,
            primaryType: "TransferWithAuthorization",
            message: auth as unknown as Record<string, unknown>,
            signature: body.signature,
          });
        } catch {
          // fall through
        }
        if (!validSignature) return reply.code(400).send({ error: "invalid_signature", digest });

        // EIP-3009 validity window (strict both ends, advisory; chain time decides).
        const now = nowSeconds();
        if (now <= auth.validAfter) {
          return reply
            .code(400)
            .send({ error: "authorization_not_yet_valid", digest, validAfter: auth.validAfter.toString() });
        }
        if (now >= auth.validBefore) {
          return reply
            .code(400)
            .send({ error: "authorization_expired", digest, validBefore: auth.validBefore.toString() });
        }

        // Random-nonce anti-replay: the authorization nonce must be unused.
        let used: boolean;
        try {
          used = (await publicClient.readContract({
            address: seur,
            abi: seurAbi,
            functionName: "authorizationState",
            args: [auth.from, auth.nonce],
          })) as boolean;
        } catch (error) {
          request.log.error(error);
          return reply.code(502).send({ error: "rpc_error", digest });
        }
        if (used) return reply.code(409).send({ error: "authorization_already_used", digest });

        return submit(request, reply, digest, {
          address: seur,
          abi: seurAbi,
          functionName: "transferWithAuthorization",
          args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, body.signature],
        });
      }
    }
  });
}

import { describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
  seurDomain,
  stableCoDomain,
} from "../src/intent.js";

const ENGINE = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" as const;
const STABLECO = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as const;
const SEUR = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const CHAIN_ID = 31337;

const paymentBody = {
  type: "payment",
  intent: {
    from: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    fromBank: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    toBank: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    to: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    amount: "1000000000",
    nonce: "0",
    deadline: "1900000000",
  },
  signature: `0x${"ab".repeat(65)}`,
};

const mintBody = {
  type: "mint",
  intent: {
    minter: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    minterBank: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    amount: "500000000",
    nonce: "0",
    deadline: "1900000000",
  },
  signature: `0x${"ab".repeat(65)}`,
};

const redeemBody = {
  type: "redeem",
  intent: {
    redeemer: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    redeemerBank: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    amount: "500000000",
    nonce: "0",
    deadline: "1900000000",
  },
  signature: `0x${"ab".repeat(65)}`,
};

const transfer3009Body = {
  type: "transfer3009",
  authorization: {
    from: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    to: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    value: "25000000",
    validAfter: "0",
    validBefore: "1900000000",
    nonce: `0x${"cd".repeat(32)}`,
  },
  signature: `0x${"ab".repeat(65)}`,
};

describe("intentRequestSchema", () => {
  it("accepts a payment body and coerces uint256 strings to bigint", () => {
    const parsed = intentRequestSchema.parse(paymentBody);
    expect(parsed.type).toBe("payment");
    if (parsed.type !== "payment") throw new Error("unreachable");
    expect(parsed.intent.amount).toBe(1_000_000_000n);
    expect(parsed.intent.nonce).toBe(0n);
  });

  it("accepts a mint body", () => {
    const parsed = intentRequestSchema.parse(mintBody);
    if (parsed.type !== "mint") throw new Error("unreachable");
    expect(parsed.intent.minter).toBe("0x976EA74026E726554dB657fA54763abd0C3a0aa9");
    expect(parsed.intent.amount).toBe(500_000_000n);
  });

  it("accepts a redeem body", () => {
    const parsed = intentRequestSchema.parse(redeemBody);
    if (parsed.type !== "redeem") throw new Error("unreachable");
    expect(parsed.intent.redeemer).toBe("0x976EA74026E726554dB657fA54763abd0C3a0aa9");
    expect(parsed.intent.amount).toBe(500_000_000n);
  });

  it("accepts a transfer3009 body and keeps the bytes32 nonce as hex", () => {
    const parsed = intentRequestSchema.parse(transfer3009Body);
    if (parsed.type !== "transfer3009") throw new Error("unreachable");
    expect(parsed.authorization.value).toBe(25_000_000n);
    expect(parsed.authorization.nonce).toBe(`0x${"cd".repeat(32)}`);
  });

  it("checksums addresses regardless of input casing", () => {
    const body = structuredClone(paymentBody);
    body.intent.from = body.intent.from.toLowerCase();
    const parsed = intentRequestSchema.parse(body);
    if (parsed.type !== "payment") throw new Error("unreachable");
    expect(parsed.intent.from).toBe("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65");
  });

  it.each([
    ["genuinely unknown type", { ...paymentBody, type: "swap" }],
    ["bad address", { ...paymentBody, intent: { ...paymentBody.intent, from: "0x123" } }],
    ["negative amount", { ...paymentBody, intent: { ...paymentBody.intent, amount: "-5" } }],
    ["decimal amount", { ...paymentBody, intent: { ...paymentBody.intent, amount: "1.5" } }],
    ["short signature", { ...paymentBody, signature: "0xabcd" }],
    ["missing intent", { type: "payment", signature: paymentBody.signature }],
    ["decimal 3009 nonce", { ...transfer3009Body, authorization: { ...transfer3009Body.authorization, nonce: "42" } }],
  ])("rejects %s", (_label, body) => {
    expect(intentRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("faucetRequestSchema", () => {
  it("accepts a valid onboarding body and checksums the address", () => {
    const parsed = faucetRequestSchema.parse({
      address: "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
      bank: "A",
    });
    expect(parsed.address).toBe("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65");
    expect(parsed.bank).toBe("A");
  });

  it.each([
    ["bad address", { address: "0x123", bank: "A" }],
    ["unknown bank", { address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", bank: "C" }],
    ["missing bank", { address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" }],
  ])("rejects %s", (_label, body) => {
    expect(faucetRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("digests", () => {
  const payment = (() => {
    const p = intentRequestSchema.parse(paymentBody);
    if (p.type !== "payment") throw new Error("unreachable");
    return p.intent;
  })();
  const mint = (() => {
    const p = intentRequestSchema.parse(mintBody);
    if (p.type !== "mint") throw new Error("unreachable");
    return p.intent;
  })();
  const redeem = (() => {
    const p = intentRequestSchema.parse(redeemBody);
    if (p.type !== "redeem") throw new Error("unreachable");
    return p.intent;
  })();
  const auth = (() => {
    const p = intentRequestSchema.parse(transfer3009Body);
    if (p.type !== "transfer3009") throw new Error("unreachable");
    return p.authorization;
  })();

  it("are deterministic per kind", () => {
    expect(intentDigest(CHAIN_ID, ENGINE, payment)).toBe(intentDigest(CHAIN_ID, ENGINE, payment));
    expect(mintDigest(CHAIN_ID, STABLECO, mint)).toBe(mintDigest(CHAIN_ID, STABLECO, mint));
    expect(redeemDigest(CHAIN_ID, STABLECO, redeem)).toBe(redeemDigest(CHAIN_ID, STABLECO, redeem));
    expect(authorizationDigest(CHAIN_ID, SEUR, auth)).toBe(authorizationDigest(CHAIN_ID, SEUR, auth));
  });

  it("separate domains/types so the kinds never collide", () => {
    // Same numeric fields, different EIP-712 domain + struct → different digests.
    const a = mintDigest(CHAIN_ID, STABLECO, mint);
    const b = redeemDigest(CHAIN_ID, STABLECO, redeem);
    expect(a).not.toBe(b);
  });

  it("change when the amount, chain or contract changes", () => {
    const base = mintDigest(CHAIN_ID, STABLECO, mint);
    expect(mintDigest(CHAIN_ID, STABLECO, { ...mint, amount: mint.amount + 1n })).not.toBe(base);
    expect(mintDigest(CHAIN_ID + 1, STABLECO, mint)).not.toBe(base);
    expect(mintDigest(CHAIN_ID, ENGINE, mint)).not.toBe(base);
  });
});

describe("signature roundtrip", () => {
  const key = `0x${"11".repeat(32)}` as const;
  const account = privateKeyToAccount(key);

  it("verifies a payment signature over the same typed data", async () => {
    const intent = { ...intentRequestSchemaPayment(), from: account.address };
    const signature = await account.signTypedData({
      domain: intentDomain(CHAIN_ID, ENGINE),
      types: PAYMENT_INTENT_TYPES,
      primaryType: "PaymentIntent",
      message: intent,
    });
    await expect(
      verifyTypedData({
        address: account.address,
        domain: intentDomain(CHAIN_ID, ENGINE),
        types: PAYMENT_INTENT_TYPES,
        primaryType: "PaymentIntent",
        message: intent,
        signature,
      }),
    ).resolves.toBe(true);
  });

  it("verifies a mint signature and rejects it once tampered", async () => {
    const intent = { ...intentRequestSchemaMint(), minter: account.address };
    const signature = await account.signTypedData({
      domain: stableCoDomain(CHAIN_ID, STABLECO),
      types: MINT_INTENT_TYPES,
      primaryType: "MintIntent",
      message: intent,
    });
    await expect(
      verifyTypedData({
        address: account.address,
        domain: stableCoDomain(CHAIN_ID, STABLECO),
        types: MINT_INTENT_TYPES,
        primaryType: "MintIntent",
        message: intent,
        signature,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyTypedData({
        address: account.address,
        domain: stableCoDomain(CHAIN_ID, STABLECO),
        types: MINT_INTENT_TYPES,
        primaryType: "MintIntent",
        message: { ...intent, amount: intent.amount + 1n },
        signature,
      }),
    ).resolves.toBe(false);
  });
});

function intentRequestSchemaPayment() {
  const p = intentRequestSchema.parse(paymentBody);
  if (p.type !== "payment") throw new Error("unreachable");
  return p.intent;
}

function intentRequestSchemaMint() {
  const p = intentRequestSchema.parse(mintBody);
  if (p.type !== "mint") throw new Error("unreachable");
  return p.intent;
}

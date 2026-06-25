import { describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { intentDigest, intentDomain, intentRequestSchema, PAYMENT_INTENT_TYPES } from "../src/intent.js";

const ENGINE = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" as const;
const CHAIN_ID = 31337;

const validBody = {
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

describe("intentRequestSchema", () => {
  it("accepts a valid payment body and coerces uint256 strings to bigint", () => {
    const parsed = intentRequestSchema.parse(validBody);
    expect(parsed.type).toBe("payment");
    expect(parsed.intent.amount).toBe(1_000_000_000n);
    expect(parsed.intent.nonce).toBe(0n);
  });

  it("checksums addresses regardless of input casing", () => {
    const body = structuredClone(validBody);
    body.intent.from = body.intent.from.toLowerCase();
    const parsed = intentRequestSchema.parse(body);
    expect(parsed.intent.from).toBe("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65");
  });

  it.each([
    ["unknown type", { ...validBody, type: "transfer3009" }],
    ["bad address", { ...validBody, intent: { ...validBody.intent, from: "0x123" } }],
    ["negative amount", { ...validBody, intent: { ...validBody.intent, amount: "-5" } }],
    ["decimal amount", { ...validBody, intent: { ...validBody.intent, amount: "1.5" } }],
    ["short signature", { ...validBody, signature: "0xabcd" }],
    ["missing intent", { type: "payment", signature: validBody.signature }],
  ])("rejects %s", (_label, body) => {
    expect(intentRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("intentDigest", () => {
  const intent = intentRequestSchema.parse(validBody).intent;

  it("is deterministic", () => {
    expect(intentDigest(CHAIN_ID, ENGINE, intent)).toBe(intentDigest(CHAIN_ID, ENGINE, intent));
  });

  it("changes when any field, the chain or the engine changes", () => {
    const base = intentDigest(CHAIN_ID, ENGINE, intent);
    expect(intentDigest(CHAIN_ID, ENGINE, { ...intent, amount: intent.amount + 1n })).not.toBe(base);
    expect(intentDigest(CHAIN_ID, ENGINE, { ...intent, nonce: 1n })).not.toBe(base);
    expect(intentDigest(CHAIN_ID + 1, ENGINE, intent)).not.toBe(base);
    expect(intentDigest(CHAIN_ID, intent.fromBank, intent)).not.toBe(base);
  });
});

describe("signature roundtrip", () => {
  const key = `0x${"11".repeat(32)}` as const;
  const account = privateKeyToAccount(key);
  const intent = { ...intentRequestSchema.parse(validBody).intent, from: account.address };

  it("verifies a signature produced over the same typed data", async () => {
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

  it("rejects the signature once a field is tampered with", async () => {
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
        message: { ...intent, amount: intent.amount + 1n },
        signature,
      }),
    ).resolves.toBe(false);
  });
});

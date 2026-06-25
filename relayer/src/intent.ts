import { getAddress, hashTypedData, type Address, type Hex } from "viem";
import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "invalid address")
  .transform((s) => getAddress(s.toLowerCase()) as Address);

// uint256 values travel as decimal strings (JSON has no bigint).
const uint256 = z
  .string()
  .regex(/^\d+$/, "expected a decimal string")
  .transform(BigInt)
  .refine((v) => v < 2n ** 256n, "does not fit in uint256");

const signature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte hex signature")
  .transform((s) => s as Hex);

/** Mirror of SettlementEngine.PaymentIntent (field order matters for EIP-712). */
export const paymentIntentSchema = z.object({
  from: address,
  fromBank: address,
  toBank: address,
  to: address,
  amount: uint256,
  nonce: uint256,
  deadline: uint256,
});

export type PaymentIntent = z.infer<typeof paymentIntentSchema>;

/**
 * Body of POST /intent. A discriminated union on `type` so the single business
 * endpoint can absorb Phase 4's signed-message kinds ("transfer3009" for gasless
 * sEUR P2P, sEUR mint/redeem intents) without an API break. Phase 3: payments only.
 */
export const intentRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("payment"),
    intent: paymentIntentSchema,
    signature,
  }),
]);

export type IntentRequest = z.infer<typeof intentRequestSchema>;

/** EIP-712 types — must match PAYMENT_INTENT_TYPEHASH in SettlementEngine.sol. */
export const PAYMENT_INTENT_TYPES = {
  PaymentIntent: [
    { name: "from", type: "address" },
    { name: "fromBank", type: "address" },
    { name: "toBank", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 domain — must match EIP712("SettlementEngine", "1") in the engine. */
export function intentDomain(chainId: number, engine: Address) {
  return {
    name: "SettlementEngine",
    version: "1",
    chainId,
    verifyingContract: engine,
  } as const;
}

/**
 * Off-chain mirror of SettlementEngine.hashIntent — the digest the payer signs,
 * also used as the idempotency key (unique per from/nonce pair by construction).
 */
export function intentDigest(chainId: number, engine: Address, intent: PaymentIntent): Hex {
  return hashTypedData({
    domain: intentDomain(chainId, engine),
    types: PAYMENT_INTENT_TYPES,
    primaryType: "PaymentIntent",
    message: intent,
  });
}

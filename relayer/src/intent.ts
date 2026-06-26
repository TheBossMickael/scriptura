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

// EIP-3009 nonces are random 32-byte hex values (NOT decimal strings — they are bytes32).
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex value")
  .transform((s) => s as Hex);

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

/** Mirror of StableCo.MintIntent. */
export const mintIntentSchema = z.object({
  minter: address,
  minterBank: address,
  amount: uint256,
  nonce: uint256,
  deadline: uint256,
});

export type MintIntent = z.infer<typeof mintIntentSchema>;

/** Mirror of StableCo.RedeemIntent. */
export const redeemIntentSchema = z.object({
  redeemer: address,
  redeemerBank: address,
  amount: uint256,
  nonce: uint256,
  deadline: uint256,
});

export type RedeemIntent = z.infer<typeof redeemIntentSchema>;

/** Mirror of StableEUR.transferWithAuthorization arguments (EIP-3009). */
export const transferAuthorizationSchema = z.object({
  from: address,
  to: address,
  value: uint256,
  validAfter: uint256,
  validBefore: uint256,
  nonce: bytes32,
});

export type TransferAuthorization = z.infer<typeof transferAuthorizationSchema>;

/**
 * Body of POST /intent. A discriminated union on `type` so the single business endpoint
 * absorbs every client-signed message kind: client payments ("payment"), sEUR issuance
 * ("mint"/"redeem"), and gasless sEUR P2P ("transfer3009"). The direct sEUR `transfer()`
 * is NOT here on purpose — that path is the holder paying their own gas, no relayer.
 */
export const intentRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("payment"), intent: paymentIntentSchema, signature }),
  z.object({ type: z.literal("mint"), intent: mintIntentSchema, signature }),
  z.object({ type: z.literal("redeem"), intent: redeemIntentSchema, signature }),
  z.object({ type: z.literal("transfer3009"), authorization: transferAuthorizationSchema, signature }),
]);

export type IntentRequest = z.infer<typeof intentRequestSchema>;

/**
 * Body of POST /faucet — a visitor's address + chosen bank (Option B public onboarding).
 * No client signature: the relayer's narrow FAUCET_ROLE is the authority, and the amount
 * is capped on-chain. This is a separate endpoint from /intent (not a signed message).
 */
export const faucetRequestSchema = z.object({
  address,
  bank: z.enum(["A", "B"]),
});

export type FaucetRequest = z.infer<typeof faucetRequestSchema>;

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

/** EIP-712 types — must match MINT_INTENT_TYPEHASH in StableCo.sol. */
export const MINT_INTENT_TYPES = {
  MintIntent: [
    { name: "minter", type: "address" },
    { name: "minterBank", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 types — must match REDEEM_INTENT_TYPEHASH in StableCo.sol. */
export const REDEEM_INTENT_TYPES = {
  RedeemIntent: [
    { name: "redeemer", type: "address" },
    { name: "redeemerBank", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 types — must match TRANSFER_WITH_AUTHORIZATION_TYPEHASH in StableEUR.sol. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** EIP-712 domain — must match EIP712("SettlementEngine", "1") in the engine. */
export function intentDomain(chainId: number, engine: Address) {
  return { name: "SettlementEngine", version: "1", chainId, verifyingContract: engine } as const;
}

/** EIP-712 domain — must match EIP712("StableCo", "1") in StableCo.sol. */
export function stableCoDomain(chainId: number, stableCo: Address) {
  return { name: "StableCo", version: "1", chainId, verifyingContract: stableCo } as const;
}

/** EIP-712 domain — must match EIP712("Stable EUR", "1") in StableEUR.sol. */
export function seurDomain(chainId: number, seur: Address) {
  return { name: "Stable EUR", version: "1", chainId, verifyingContract: seur } as const;
}

/**
 * Off-chain mirror of SettlementEngine.hashIntent — the digest the payer signs, also the
 * idempotency key (unique per from/nonce pair by construction).
 */
export function intentDigest(chainId: number, engine: Address, intent: PaymentIntent): Hex {
  return hashTypedData({
    domain: intentDomain(chainId, engine),
    types: PAYMENT_INTENT_TYPES,
    primaryType: "PaymentIntent",
    message: intent,
  });
}

/** Off-chain mirror of StableCo.hashMintIntent (idempotency key for a mint). */
export function mintDigest(chainId: number, stableCo: Address, intent: MintIntent): Hex {
  return hashTypedData({
    domain: stableCoDomain(chainId, stableCo),
    types: MINT_INTENT_TYPES,
    primaryType: "MintIntent",
    message: intent,
  });
}

/** Off-chain mirror of StableCo.hashRedeemIntent (idempotency key for a redeem). */
export function redeemDigest(chainId: number, stableCo: Address, intent: RedeemIntent): Hex {
  return hashTypedData({
    domain: stableCoDomain(chainId, stableCo),
    types: REDEEM_INTENT_TYPES,
    primaryType: "RedeemIntent",
    message: intent,
  });
}

/** EIP-712 digest of an EIP-3009 transfer authorization (idempotency key for a transfer3009). */
export function authorizationDigest(chainId: number, seur: Address, auth: TransferAuthorization): Hex {
  return hashTypedData({
    domain: seurDomain(chainId, seur),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
}

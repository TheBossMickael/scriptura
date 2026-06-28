import type { Address, Hex } from "viem";

/**
 * EIP-712 message types and domains, mirroring the contracts and `relayer/src/intent.ts`
 * exactly (field order and domain name/version are consensus-critical). The frontend builds
 * these messages and signs them with MetaMask; the relayer re-verifies and relays.
 */

export interface PaymentIntent {
  from: Address;
  fromBank: Address;
  toBank: Address;
  to: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface MintIntent {
  minter: Address;
  minterBank: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface RedeemIntent {
  redeemer: Address;
  redeemerBank: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface TransferAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** Matches PAYMENT_INTENT_TYPEHASH in SettlementEngine.sol. */
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

/** Matches MINT_INTENT_TYPEHASH in StableCo.sol. */
export const MINT_INTENT_TYPES = {
  MintIntent: [
    { name: "minter", type: "address" },
    { name: "minterBank", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Matches REDEEM_INTENT_TYPEHASH in StableCo.sol. */
export const REDEEM_INTENT_TYPES = {
  RedeemIntent: [
    { name: "redeemer", type: "address" },
    { name: "redeemerBank", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Matches TRANSFER_WITH_AUTHORIZATION_TYPEHASH in StableEUR.sol (EIP-3009). */
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

/** EIP712("SettlementEngine", "1"). */
export function intentDomain(chainId: number, engine: Address) {
  return { name: "SettlementEngine", version: "1", chainId, verifyingContract: engine } as const;
}

/** EIP712("StableCo", "1"). */
export function stableCoDomain(chainId: number, stableCo: Address) {
  return { name: "StableCo", version: "1", chainId, verifyingContract: stableCo } as const;
}

/** EIP712("Stable EUR", "1"). */
export function seurDomain(chainId: number, seur: Address) {
  return { name: "Stable EUR", version: "1", chainId, verifyingContract: seur } as const;
}

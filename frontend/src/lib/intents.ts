import { bytesToHex, type Hex } from "viem";

/** Last valid UNIX timestamp (inclusive) `seconds` from now — used as intent deadlines. */
export function deadlineIn(seconds = 3600): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

/** A fresh random 32-byte nonce for an EIP-3009 authorization. */
export function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * EIP-3009 validity window. validAfter = 0 (immediately valid — the relayer/contract require
 * `now` strictly after it), validBefore = now + `seconds` (strict upper bound).
 */
export function authorizationWindow(seconds = 3600): { validAfter: bigint; validBefore: bigint } {
  return { validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + seconds) };
}

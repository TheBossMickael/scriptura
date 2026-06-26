/**
 * E2E smoke script (`npm run send-intent [amount]`): signs a PaymentIntent as alice1
 * paying bob1 (Bank A -> Bank B), POSTs it to the relayer, waits for the receipt, prints
 * balances before/after, then re-POSTs the same body to demonstrate idempotency. Requires
 * a running chain + deployed contracts + running relayer.
 *
 * DEV/TEST ONLY: this is the single place that needs a CLIENT private key (alice1 must
 * sign). It reads ALICE1_PK from the env — a public Anvil key locally, NEVER a real key.
 * In production clients sign from their own wallets; the backend only ever holds addresses.
 */
import { randomBytes } from "node:crypto";
import { createPublicClient, formatUnits, getAddress, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, settlementEngineAbi, stableCoAbi } from "../src/abi.js";
import { loadConfig } from "../src/config.js";
import {
  intentDomain,
  MINT_INTENT_TYPES,
  PAYMENT_INTENT_TYPES,
  seurDomain,
  stableCoDomain,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "../src/intent.js";

const cfg = loadConfig();
const relayerUrl = process.env.RELAYER_URL ?? `http://127.0.0.1:${cfg.port}`;
const amount = parseUnits(process.argv[2] ?? "1000", 6); // default: 1_000 DEP

const alice1Pk = process.env.ALICE1_PK;
if (!alice1Pk || !/^0x[0-9a-fA-F]{64}$/.test(alice1Pk)) {
  throw new Error("ALICE1_PK is required for the smoke script (public Anvil key locally; never a real client key)");
}
const bob1Address = process.env.BOB1_ADDRESS;
if (!bob1Address) {
  throw new Error("BOB1_ADDRESS is required for the smoke script");
}

const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
const { settlementEngine: engine, stableCo, seur, bankA, bankB, depA, depB, chainId } = cfg.deployments;

const alice1 = privateKeyToAccount(alice1Pk as Hex);
const bob1 = getAddress(bob1Address);

const balances = async (label: string) => {
  const [a, b] = await Promise.all([
    publicClient.readContract({ address: depA, abi: erc20Abi, functionName: "balanceOf", args: [alice1.address] }),
    publicClient.readContract({ address: depB, abi: erc20Abi, functionName: "balanceOf", args: [bob1] }),
  ]);
  console.log(`${label}: alice1 ${formatUnits(a, 6)} DEP-A | bob1 ${formatUnits(b, 6)} DEP-B`);
};

const post = async (body: unknown) => {
  const response = await fetch(`${relayerUrl}/intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  console.log(`POST /intent -> ${response.status}`, json);
  return json;
};

await balances("before");

const nonce = await publicClient.readContract({
  address: engine,
  abi: settlementEngineAbi,
  functionName: "nonces",
  args: [alice1.address],
});

const intent = {
  from: alice1.address,
  fromBank: bankA,
  toBank: bankB,
  to: bob1,
  amount,
  nonce,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
};

const signature = await alice1.signTypedData({
  domain: intentDomain(chainId, engine),
  types: PAYMENT_INTENT_TYPES,
  primaryType: "PaymentIntent",
  message: intent,
});

// uint256 fields travel as decimal strings (the relayer's zod schema re-parses them).
const body = {
  type: "payment",
  intent: {
    ...intent,
    amount: intent.amount.toString(),
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
  },
  signature,
};

const first = await post(body);
if (!first.txHash) {
  console.error("relayer rejected the intent, aborting");
  process.exit(1);
}

const receipt = await publicClient.waitForTransactionReceipt({ hash: first.txHash as Hex });
console.log(`mined in block ${receipt.blockNumber} (${receipt.status})`);

await balances("after");

// Same signed body again: the relayer must answer from its idempotency cache with
// the SAME txHash (and the final status thanks to the receipt watcher), not resubmit.
const replay = await post(body);
if (replay.idempotent !== true || replay.txHash !== first.txHash) {
  console.error("idempotency check FAILED");
  process.exit(1);
}
console.log("idempotency check OK");

/*//////////////////////////////////////////////////////////////
              PHASE 4 — sEUR MINT + GASLESS P2P
//////////////////////////////////////////////////////////////*/

const seurBalances = async (label: string) => {
  const [a, b] = await Promise.all([
    publicClient.readContract({ address: seur, abi: erc20Abi, functionName: "balanceOf", args: [alice1.address] }),
    publicClient.readContract({ address: seur, abi: erc20Abi, functionName: "balanceOf", args: [bob1] }),
  ]);
  console.log(`${label}: alice1 ${formatUnits(a, 6)} sEUR | bob1 ${formatUnits(b, 6)} sEUR`);
};

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

console.log("\n--- mint sEUR (alice1, same-bank) ---");
await seurBalances("before");

const mintNonce = await publicClient.readContract({
  address: stableCo,
  abi: stableCoAbi,
  functionName: "nonces",
  args: [alice1.address],
});
const mintIntent = { minter: alice1.address, minterBank: bankA, amount: parseUnits("500", 6), nonce: mintNonce, deadline: deadline() };
const mintSig = await alice1.signTypedData({
  domain: stableCoDomain(chainId, stableCo),
  types: MINT_INTENT_TYPES,
  primaryType: "MintIntent",
  message: mintIntent,
});
const mintRes = await post({
  type: "mint",
  intent: { ...mintIntent, amount: mintIntent.amount.toString(), nonce: mintIntent.nonce.toString(), deadline: mintIntent.deadline.toString() },
  signature: mintSig,
});
if (!mintRes.txHash) {
  console.error("relayer rejected the mint, aborting");
  process.exit(1);
}
await publicClient.waitForTransactionReceipt({ hash: mintRes.txHash as Hex });
await seurBalances("after mint");

console.log("\n--- gasless P2P sEUR (alice1 -> bob1, EIP-3009) ---");
const authNonce = `0x${randomBytes(32).toString("hex")}` as Hex;
const auth = {
  from: alice1.address,
  to: bob1,
  value: parseUnits("100", 6),
  validAfter: 0n,
  validBefore: deadline(),
  nonce: authNonce,
};
const authSig = await alice1.signTypedData({
  domain: seurDomain(chainId, seur),
  types: TRANSFER_WITH_AUTHORIZATION_TYPES,
  primaryType: "TransferWithAuthorization",
  message: auth,
});
const authRes = await post({
  type: "transfer3009",
  authorization: {
    ...auth,
    value: auth.value.toString(),
    validAfter: auth.validAfter.toString(),
    validBefore: auth.validBefore.toString(),
  },
  signature: authSig,
});
if (!authRes.txHash) {
  console.error("relayer rejected the gasless transfer, aborting");
  process.exit(1);
}
await publicClient.waitForTransactionReceipt({ hash: authRes.txHash as Hex });
await seurBalances("after gasless transfer");

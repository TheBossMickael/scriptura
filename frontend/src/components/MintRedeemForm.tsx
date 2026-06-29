import { useState } from "react";
import { usePublicClient, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import { Button, Field } from "./ui";
import { TxStatus } from "./TxStatus";
import { useTx } from "../hooks/useActions";
import { stableCoAbi } from "../lib/abis";
import { BANKS, deployment, expectedChainId, type BankKey } from "../lib/directory";
import {
  MINT_INTENT_TYPES,
  REDEEM_INTENT_TYPES,
  stableCoDomain,
  type MintIntent,
  type RedeemIntent,
} from "../lib/eip712";
import { submitMint, submitRedeem } from "../lib/relayer";
import { deadlineIn } from "../lib/intents";
import { formatAmount, parseAmount, tryParseAmount } from "../lib/format";

/** Mint or redeem sEUR 1:1 against the client's deposits (gasless EIP-712 intents). */
export function MintRedeemForm({
  account,
  bankKey,
  depBalance,
  seurBalance,
}: {
  account: Address;
  bankKey: BankKey;
  depBalance: bigint | undefined;
  seurBalance: bigint | undefined;
}) {
  const { relay, feedback, isBusy } = useTx();
  const { signTypedDataAsync } = useSignTypedData();
  const publicClient = usePublicClient();
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const parsed = tryParseAmount(amount);
  const insufficientDep = parsed !== undefined && depBalance !== undefined && parsed > depBalance;
  const insufficientSeur = parsed !== undefined && seurBalance !== undefined && parsed > seurBalance;

  async function readNonce(): Promise<bigint> {
    return (await publicClient!.readContract({
      address: deployment.stableCo,
      abi: stableCoAbi,
      functionName: "nonces",
      args: [account],
    })) as bigint;
  }

  function parseOrError(): bigint | null {
    try {
      const v = parseAmount(amount);
      if (v <= 0n) {
        setFormError("Amount must be positive.");
        return null;
      }
      return v;
    } catch {
      setFormError("Invalid amount.");
      return null;
    }
  }

  async function onMint() {
    setFormError(null);
    if (!publicClient) return setFormError("RPC client unavailable.");
    const value = parseOrError();
    if (value === null) return;
    const intent: MintIntent = {
      minter: account,
      minterBank: BANKS[bankKey].bank,
      amount: value,
      nonce: await readNonce(),
      deadline: deadlineIn(),
    };
    const ok = await relay(
      "Mint sEUR",
      () =>
        signTypedDataAsync({
          domain: stableCoDomain(expectedChainId, deployment.stableCo),
          types: MINT_INTENT_TYPES,
          primaryType: "MintIntent",
          message: intent,
        }),
      (signature) => submitMint(intent, signature),
    );
    if (ok) setAmount("");
  }

  async function onRedeem() {
    setFormError(null);
    if (!publicClient) return setFormError("RPC client unavailable.");
    const value = parseOrError();
    if (value === null) return;
    const intent: RedeemIntent = {
      redeemer: account,
      redeemerBank: BANKS[bankKey].bank,
      amount: value,
      nonce: await readNonce(),
      deadline: deadlineIn(),
    };
    const ok = await relay(
      "Redeem sEUR",
      () =>
        signTypedDataAsync({
          domain: stableCoDomain(expectedChainId, deployment.stableCo),
          types: REDEEM_INTENT_TYPES,
          primaryType: "RedeemIntent",
          message: intent,
        }),
      (signature) => submitRedeem(intent, signature),
    );
    if (ok) setAmount("");
  }

  return (
    <div>
      <Field
        label="Amount"
        hint={
          depBalance !== undefined && seurBalance !== undefined
            ? `Balances — DEP: ${formatAmount(depBalance)} · sEUR: ${formatAmount(seurBalance)}`
            : undefined
        }
      >
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 500" disabled={isBusy} inputMode="decimal" />
      </Field>
      {formError && <p className="note note-bad">{formError}</p>}
      <div className="btn-row">
        <Button onClick={onMint} disabled={isBusy || !amount || insufficientDep}>
          Buy sEUR (mint)
        </Button>
        <Button variant="secondary" onClick={onRedeem} disabled={isBusy || !amount || insufficientSeur}>
          Sell sEUR (redeem)
        </Button>
      </div>
      <p className="note">Mint: DEP → sEUR · Redeem: sEUR → DEP (1:1)</p>
      <TxStatus feedback={feedback} />
    </div>
  );
}

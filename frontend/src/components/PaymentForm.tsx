import { useMemo, useState } from "react";
import { useSignTypedData, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { Button, Field } from "./ui";
import { TxStatus } from "./TxStatus";
import { useTx } from "../hooks/useActions";
import { settlementEngineAbi } from "../lib/abis";
import { BANKS, CLIENTS, deployment, expectedChainId, type BankKey } from "../lib/directory";
import { PAYMENT_INTENT_TYPES, intentDomain, type PaymentIntent } from "../lib/eip712";
import { submitPayment } from "../lib/relayer";
import { deadlineIn } from "../lib/intents";
import { formatAmount, looksLikeAddress, parseAmount, tryParseAmount } from "../lib/format";

/** Client payment form: builds a PaymentIntent, signs it (EIP-712), relays it gasless. */
export function PaymentForm({
  account,
  bankKey,
  depBalance,
}: {
  account: Address;
  bankKey: BankKey;
  depBalance: bigint | undefined;
}) {
  const { relay, feedback, isBusy } = useTx();
  const { signTypedDataAsync } = useSignTypedData();
  const publicClient = usePublicClient();

  const others = CLIENTS.filter((c) => c.address.toLowerCase() !== account.toLowerCase());
  const [mode, setMode] = useState<"known" | "manual">("known");
  const [known, setKnown] = useState<Address>(others[0]?.address ?? ("" as Address));
  const [manualAddr, setManualAddr] = useState("");
  const [manualBank, setManualBank] = useState<BankKey>("B");
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const recipient: { address: string; bankKey: BankKey } | null = useMemo(() => {
    if (mode === "known") {
      const c = others.find((o) => o.address === known);
      return c ? { address: c.address, bankKey: c.bankKey } : null;
    }
    return looksLikeAddress(manualAddr) ? { address: manualAddr.trim(), bankKey: manualBank } : null;
  }, [mode, known, manualAddr, manualBank, others]);

  const interbank = recipient ? recipient.bankKey !== bankKey : false;
  const parsed = tryParseAmount(amount);
  const insufficient = parsed !== undefined && depBalance !== undefined && parsed > depBalance;

  async function onSubmit() {
    setFormError(null);
    if (!recipient) return setFormError("Invalid recipient.");
    if (!publicClient) return setFormError("RPC client unavailable.");
    let value: bigint;
    try {
      value = parseAmount(amount);
    } catch {
      return setFormError("Invalid amount.");
    }
    if (value <= 0n) return setFormError("Amount must be positive.");

    const engine = deployment.settlementEngine;
    const nonce = (await publicClient.readContract({
      address: engine,
      abi: settlementEngineAbi,
      functionName: "nonces",
      args: [account],
    })) as bigint;

    const intent: PaymentIntent = {
      from: account,
      fromBank: BANKS[bankKey].bank,
      toBank: BANKS[recipient.bankKey].bank,
      to: recipient.address as Address,
      amount: value,
      nonce,
      deadline: deadlineIn(),
    };

    const ok = await relay(
      "Payment",
      () =>
        signTypedDataAsync({
          domain: intentDomain(expectedChainId, engine),
          types: PAYMENT_INTENT_TYPES,
          primaryType: "PaymentIntent",
          message: intent,
        }),
      (signature) => submitPayment(intent, signature),
    );
    if (ok) setAmount("");
  }

  return (
    <div>
      <Field label="Recipient">
        <select value={mode} onChange={(e) => setMode(e.target.value as "known" | "manual")} disabled={isBusy}>
          <option value="known">Known client</option>
          <option value="manual">Manual address</option>
        </select>
      </Field>

      {mode === "known" ? (
        <Field label="Client">
          <select value={known} onChange={(e) => setKnown(e.target.value as Address)} disabled={isBusy}>
            {others.map((c) => (
              <option key={c.address} value={c.address}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <Field label="Recipient address">
            <input value={manualAddr} onChange={(e) => setManualAddr(e.target.value)} placeholder="0x…" disabled={isBusy} />
          </Field>
          <Field label="Recipient's bank">
            <select value={manualBank} onChange={(e) => setManualBank(e.target.value as BankKey)} disabled={isBusy}>
              <option value="A">Bank A</option>
              <option value="B">Bank B</option>
            </select>
          </Field>
        </>
      )}

      <Field
        label="Amount (DEP)"
        hint={depBalance !== undefined ? `Available balance: ${formatAmount(depBalance)} ${BANKS[bankKey].depSymbol}` : undefined}
      >
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1000" disabled={isBusy} inputMode="decimal" />
      </Field>

      {recipient && (
        <p className="note">
          {interbank
            ? `Interbank payment: settled in central-bank money (wCBDC) from ${BANKS[bankKey].label} to ${BANKS[recipient.bankKey].label}, atomically in the same transaction.`
            : "Intrabank payment: a simple deposit transfer within the same bank, no central-bank money."}
        </p>
      )}
      {formError && <p className="note note-bad">{formError}</p>}

      <div className="btn-row">
        <Button onClick={onSubmit} disabled={isBusy || !recipient || !amount || insufficient}>
          Pay (gasless)
        </Button>
      </div>
      <TxStatus feedback={feedback} />
    </div>
  );
}

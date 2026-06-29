import { useState } from "react";
import { useBalance, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import { Button, Field } from "./ui";
import { TxStatus } from "./TxStatus";
import { useTx } from "../hooks/useActions";
import { seurAbi } from "../lib/abis";
import { deployment, expectedChainId } from "../lib/directory";
import { SEPOLIA_ETH_FAUCET_URL } from "../lib/env";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, seurDomain, type TransferAuthorization } from "../lib/eip712";
import { submitTransfer3009 } from "../lib/relayer";
import { authorizationWindow, randomNonce } from "../lib/intents";
import { formatAmount, looksLikeAddress, parseAmount, tryParseAmount } from "../lib/format";

/** Two P2P sEUR paths: gasless (EIP-3009 via relayer) and direct (holder pays gas). */
export function P2PForm({ account, seurBalance }: { account: Address; seurBalance: bigint | undefined }) {
  const { relay, direct, feedback, isBusy } = useTx();
  const { signTypedDataAsync } = useSignTypedData();
  const gas = useBalance({ address: account });

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const hasGas = (gas.data?.value ?? 0n) > 0n;
  const parsed = tryParseAmount(amount);
  const insufficient = parsed !== undefined && seurBalance !== undefined && parsed > seurBalance;

  function validate(): { to: Address; value: bigint } | null {
    setFormError(null);
    if (!looksLikeAddress(to)) {
      setFormError("Invalid recipient address.");
      return null;
    }
    let value: bigint;
    try {
      value = parseAmount(amount);
    } catch {
      setFormError("Invalid amount.");
      return null;
    }
    if (value <= 0n) {
      setFormError("Amount must be positive.");
      return null;
    }
    return { to: to.trim() as Address, value };
  }

  async function onGasless() {
    const v = validate();
    if (!v) return;
    const window = authorizationWindow();
    const auth: TransferAuthorization = {
      from: account,
      to: v.to,
      value: v.value,
      validAfter: window.validAfter,
      validBefore: window.validBefore,
      nonce: randomNonce(),
    };
    const ok = await relay(
      "sEUR transfer (gasless)",
      () =>
        signTypedDataAsync({
          domain: seurDomain(expectedChainId, deployment.seur),
          types: TRANSFER_WITH_AUTHORIZATION_TYPES,
          primaryType: "TransferWithAuthorization",
          message: auth,
        }),
      (signature) => submitTransfer3009(auth, signature),
    );
    if (ok) setAmount("");
  }

  async function onDirect() {
    const v = validate();
    if (!v) return;
    const ok = await direct("sEUR transfer (direct)", {
      address: deployment.seur,
      abi: seurAbi,
      functionName: "transfer",
      args: [v.to, v.value],
    });
    if (ok) setAmount("");
  }

  return (
    <div>
      <Field label="Recipient">
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" disabled={isBusy} />
      </Field>
      <Field
        label="Amount (sEUR)"
        hint={seurBalance !== undefined ? `Available balance: ${formatAmount(seurBalance)} sEUR` : undefined}
      >
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 50" disabled={isBusy} inputMode="decimal" />
      </Field>
      {formError && <p className="note note-bad">{formError}</p>}

      <div className="btn-row">
        <Button onClick={onGasless} disabled={isBusy || !amount || !to || insufficient}>
          Send gasless (relayer)
        </Button>
        <Button variant="secondary" onClick={onDirect} disabled={isBusy || !amount || !to || insufficient || !hasGas}>
          Send directly — I pay gas
        </Button>
      </div>

      {!hasGas && (
        <p className="note">
          The direct transfer needs sETH for gas.{" "}
          <a href={SEPOLIA_ETH_FAUCET_URL} target="_blank" rel="noreferrer">
            Get sETH (Sepolia)
          </a>
          . The gasless path needs no sETH.
        </p>
      )}
      <TxStatus feedback={feedback} />
    </div>
  );
}

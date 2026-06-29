import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { Button, Card, Field } from "./ui";
import { TxStatus } from "./TxStatus";
import { useTx } from "../hooks/useActions";
import { getHealth } from "../lib/relayer";
import { SEPOLIA_ETH_FAUCET_URL } from "../lib/env";
import { formatAmount } from "../lib/format";
import type { BankKey } from "../lib/directory";

/** Modal: pick a bank, get test deposits via the relayer faucet (Option B onboarding). */
function JoinModal({ account, onClose }: { account: Address; onClose: () => void }) {
  const { faucetOnboard, feedback, isBusy } = useTx();
  const [bank, setBank] = useState<BankKey>("A");
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, retry: false });

  const amountLabel = health.data ? `${formatAmount(BigInt(health.data.faucetAmount))} DEP` : "test deposits";

  async function onConfirm() {
    const ok = await faucetOnboard(account, bank);
    if (ok) onClose();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>Join the demo</h2>
        <p className="muted">
          You become a client of the chosen bank and receive {amountLabel}. You can then pay and mint/redeem sEUR —
          all <strong>gasless</strong> (the relayer pays).
        </p>

        <Field label="Bank">
          <select value={bank} onChange={(e) => setBank(e.target.value as BankKey)} disabled={isBusy}>
            <option value="A">Bank A</option>
            <option value="B">Bank B</option>
          </select>
        </Field>

        <p className="note">
          No sETH needed to join or pay. sETH is only required for the <em>direct</em> sEUR transfer —{" "}
          <a href={SEPOLIA_ETH_FAUCET_URL} target="_blank" rel="noreferrer">
            Sepolia faucet
          </a>
          .
        </p>

        <div className="btn-row">
          <Button onClick={onConfirm} disabled={isBusy}>
            Join {bank === "A" ? "Bank A" : "Bank B"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={isBusy}>
            Cancel
          </Button>
        </div>
        <TxStatus feedback={feedback} />
      </div>
    </div>
  );
}

/** The "Join" affordance shown to a connected-but-unknown wallet in the observer view. */
export function JoinCard({ account }: { account: Address }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title="Connected, but not a client yet">
      <p className="muted">Join a bank to act (pay, mint/redeem sEUR) instead of only observing.</p>
      <div className="btn-row">
        <Button onClick={() => setOpen(true)}>Join / get test euros</Button>
      </div>
      {open && <JoinModal account={account} onClose={() => setOpen(false)} />}
    </Card>
  );
}

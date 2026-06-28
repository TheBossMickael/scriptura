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

  const amountLabel = health.data ? `${formatAmount(BigInt(health.data.faucetAmount))} DEP` : "des dépôts de test";

  async function onConfirm() {
    const ok = await faucetOnboard(account, bank);
    if (ok) onClose();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>Rejoindre la démo</h2>
        <p className="muted">
          Vous devenez client de la banque choisie et recevez {amountLabel}. Vous pourrez ensuite payer, mint/redeem du
          sEUR — le tout <strong>sans gas</strong> (le relayer paie).
        </p>

        <Field label="Banque">
          <select value={bank} onChange={(e) => setBank(e.target.value as BankKey)} disabled={isBusy}>
            <option value="A">Banque A</option>
            <option value="B">Banque B</option>
          </select>
        </Field>

        <p className="note">
          Pas besoin de sETH pour rejoindre ou payer. Le sETH n'est requis que pour le transfert sEUR <em>direct</em> —{" "}
          <a href={SEPOLIA_ETH_FAUCET_URL} target="_blank" rel="noreferrer">
            faucet Sepolia
          </a>
          .
        </p>

        <div className="btn-row">
          <Button onClick={onConfirm} disabled={isBusy}>
            Rejoindre la {bank === "A" ? "Banque A" : "Banque B"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={isBusy}>
            Annuler
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
    <Card title="Vous êtes connecté, mais pas encore client">
      <p className="muted">
        Rejoignez une banque pour agir (payer, mint/redeem du sEUR) au lieu de seulement observer.
      </p>
      <div className="btn-row">
        <Button onClick={() => setOpen(true)}>Rejoindre / obtenir des euros de test</Button>
      </div>
      {open && <JoinModal account={account} onClose={() => setOpen(false)} />}
    </Card>
  );
}

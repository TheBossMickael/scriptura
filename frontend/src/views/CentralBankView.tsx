import { useState } from "react";
import { useReadContract } from "wagmi";
import { Badge, Button, Card, Field, Stat } from "../components/ui";
import { Amount, HealthBadge, Percent } from "../components/metrics";
import { BreachesList, PaymentsList } from "../components/History";
import { TxStatus } from "../components/TxStatus";
import { useTx } from "../hooks/useActions";
import { useSystemSnapshot } from "../hooks/useReads";
import { usePayments, useRatioBreaches } from "../hooks/usePonder";
import { centralBankAbi } from "../lib/abis";
import { BANKS, deployment, type BankInfo } from "../lib/directory";

function AllowlistRow({
  bank,
  onRegister,
  onRemove,
  disabled,
}: {
  bank: BankInfo;
  onRegister: (bank: BankInfo) => void;
  onRemove: (bank: BankInfo) => void;
  disabled: boolean;
}) {
  const registered = useReadContract({
    address: deployment.centralBank,
    abi: centralBankAbi,
    functionName: "isRegisteredBank",
    args: [bank.bank],
    query: { refetchInterval: 5000 },
  });

  return (
    <tr>
      <td>{bank.label}</td>
      <td>{registered.data ? <Badge tone="good">Inscrite</Badge> : <Badge tone="bad">Retirée</Badge>}</td>
      <td>
        {registered.data ? (
          <Button variant="ghost" disabled={disabled} onClick={() => onRemove(bank)}>
            Retirer
          </Button>
        ) : (
          <Button disabled={disabled} onClick={() => onRegister(bank)}>
            Inscrire
          </Button>
        )}
      </td>
    </tr>
  );
}

function AllowlistSection() {
  const { direct, feedback, isBusy } = useTx();

  const onRegister = (bank: BankInfo) =>
    direct("Inscrire une banque", {
      address: deployment.centralBank,
      abi: centralBankAbi,
      functionName: "registerBank",
      args: [bank.bank],
    });
  const onRemove = (bank: BankInfo) =>
    direct("Retirer une banque", {
      address: deployment.centralBank,
      abi: centralBankAbi,
      functionName: "removeBank",
      args: [bank.bank],
    });

  return (
    <Card title="Allowlist des banques">
      <table className="table">
        <thead>
          <tr>
            <th>Banque</th>
            <th>Statut</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <AllowlistRow bank={BANKS.A} onRegister={onRegister} onRemove={onRemove} disabled={isBusy} />
          <AllowlistRow bank={BANKS.B} onRegister={onRegister} onRemove={onRemove} disabled={isBusy} />
        </tbody>
      </table>
      <TxStatus feedback={feedback} />
    </Card>
  );
}

function ThresholdForm() {
  const { direct, feedback, isBusy } = useTx();
  const [percent, setPercent] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSet() {
    setError(null);
    const p = Number(percent.replace(",", "."));
    if (!Number.isFinite(p) || p < 0 || p > 100) return setError("Pourcentage entre 0 et 100.");
    const bps = BigInt(Math.round(p * 100));
    const ok = await direct("Changer le seuil", {
      address: deployment.centralBank,
      abi: centralBankAbi,
      functionName: "setReserveRatioThreshold",
      args: [bps],
    });
    if (ok) setPercent("");
  }

  return (
    <Card title="Paramètre de ratio">
      <Field label="Nouveau seuil (%)" hint="paramètre macroprudentiel ; ne bloque jamais un paiement (contrainte soft)">
        <input value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="ex. 10" disabled={isBusy} inputMode="decimal" />
      </Field>
      {error && <p className="note note-bad">{error}</p>}
      <div className="btn-row">
        <Button onClick={onSet} disabled={isBusy || !percent}>
          Appliquer le seuil
        </Button>
      </div>
      <TxStatus feedback={feedback} />
    </Card>
  );
}

export function CentralBankView() {
  const s = useSystemSnapshot();
  const breaches = useRatioBreaches({ limit: 20 });
  const payments = usePayments({ limit: 25 });
  const totalM1 = s.bankA.m1 !== undefined && s.bankB.m1 !== undefined ? s.bankA.m1 + s.bankB.m1 : undefined;

  return (
    <div className="stack">
      <Card title="Agrégats macro">
        <div className="stat-grid">
          <Stat label="M0 (wCBDC)" value={<Amount value={s.m0} symbol="wCBDC" />} />
          <Stat label="M1 total" value={<Amount value={totalM1} />} />
          <Stat label="sEUR" value={<Amount value={s.stable.supply} symbol="sEUR" />} />
          <Stat label="Seuil réglementaire" value={<Percent bps={s.thresholdBps} />} />
        </div>
      </Card>

      <div className="grid-2">
        {(["A", "B"] as const).map((key) => {
          const bank = key === "A" ? s.bankA : s.bankB;
          return (
            <Card
              key={key}
              title={BANKS[key].label}
              actions={<HealthBadge ratioBps={bank.ratioBps} thresholdBps={s.thresholdBps} reserves={bank.reserves} />}
            >
              <div className="stat-grid">
                <Stat label="Réserves (wCBDC)" value={<Amount value={bank.reserves} />} />
                <Stat label={`Dépôts (${BANKS[key].depSymbol})`} value={<Amount value={bank.m1} />} />
                <Stat label="Ratio" value={<Percent bps={bank.ratioBps} />} />
              </div>
            </Card>
          );
        })}
      </div>

      <div className="grid-2">
        <AllowlistSection />
        <ThresholdForm />
      </div>

      <Card title="Mur d'alertes — ReserveRatioBreached">
        <BreachesList rows={breaches.data} />
      </Card>

      <Card title="Flux interbancaires & paiements">
        <PaymentsList rows={payments.data} />
      </Card>
    </div>
  );
}

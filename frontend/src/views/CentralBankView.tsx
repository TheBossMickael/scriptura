import { useState } from "react";
import { useReadContract } from "wagmi";
import { Badge, Button, Card, Field, Stat } from "../components/ui";
import { Amount, HealthBadge, Percent } from "../components/metrics";
import { BreachesList, PaymentsList } from "../components/History";
import { TxStatus } from "../components/TxStatus";
import { ReadOnlyBanner } from "../components/Explore";
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
    query: { refetchInterval: 15_000 },
  });

  return (
    <tr>
      <td>{bank.label}</td>
      <td>{registered.data ? <Badge tone="good">Registered</Badge> : <Badge tone="bad">Removed</Badge>}</td>
      <td>
        {registered.data ? (
          <Button variant="ghost" disabled={disabled} onClick={() => onRemove(bank)}>
            Remove
          </Button>
        ) : (
          <Button disabled={disabled} onClick={() => onRegister(bank)}>
            Register
          </Button>
        )}
      </td>
    </tr>
  );
}

function AllowlistSection() {
  const { direct, feedback, isBusy } = useTx();

  const onRegister = (bank: BankInfo) =>
    direct("Register a bank", {
      address: deployment.centralBank,
      abi: centralBankAbi,
      functionName: "registerBank",
      args: [bank.bank],
    });
  const onRemove = (bank: BankInfo) =>
    direct("Remove a bank", {
      address: deployment.centralBank,
      abi: centralBankAbi,
      functionName: "removeBank",
      args: [bank.bank],
    });

  return (
    <Card title="Bank allowlist">
      <table className="table">
        <thead>
          <tr>
            <th>Bank</th>
            <th>Status</th>
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
    if (!Number.isFinite(p) || p < 0 || p > 100) return setError("Percentage between 0 and 100.");
    const bps = BigInt(Math.round(p * 100));
    const ok = await direct("Change threshold", {
      address: deployment.centralBank,
      abi: centralBankAbi,
      functionName: "setReserveRatioThreshold",
      args: [bps],
    });
    if (ok) setPercent("");
  }

  return (
    <Card title="Ratio parameter">
      <Field label="New threshold (%)" hint="macroprudential parameter; never blocks a payment (soft constraint)">
        <input value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="e.g. 10" disabled={isBusy} inputMode="decimal" />
      </Field>
      {error && <p className="note note-bad">{error}</p>}
      <div className="btn-row">
        <Button onClick={onSet} disabled={isBusy || !percent}>
          Apply threshold
        </Button>
      </div>
      <TxStatus feedback={feedback} />
    </Card>
  );
}

export function CentralBankView({ readOnly }: { readOnly?: boolean }) {
  const s = useSystemSnapshot();
  const breaches = useRatioBreaches({ limit: 20 });
  const payments = usePayments({ limit: 25 });
  const totalM1 = s.bankA.m1 !== undefined && s.bankB.m1 !== undefined ? s.bankA.m1 + s.bankB.m1 : undefined;

  return (
    <div className="stack">
      {readOnly && <ReadOnlyBanner role="central bank" />}
      <Card title="Macro aggregates">
        <div className="stat-grid">
          <Stat label="M0 (wCBDC)" value={<Amount value={s.m0} symbol="wCBDC" />} />
          <Stat label="Total M1" value={<Amount value={totalM1} />} />
          <Stat label="sEUR" value={<Amount value={s.stable.supply} symbol="sEUR" />} />
          <Stat label="Regulatory threshold" value={<Percent bps={s.thresholdBps} />} />
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
                <Stat label="Reserves (wCBDC)" value={<Amount value={bank.reserves} />} />
                <Stat label={`Deposits (${BANKS[key].depSymbol})`} value={<Amount value={bank.m1} />} />
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

      <Card title="Alert wall — ReserveRatioBreached">
        <BreachesList rows={breaches.data} />
      </Card>

      <Card title="Interbank flows & payments">
        <PaymentsList rows={payments.data} />
      </Card>
    </div>
  );
}

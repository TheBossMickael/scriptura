import type { ReactNode } from "react";
import { Card, Stat } from "../components/ui";
import { Amount, HealthBadge, Percent, RatioGauge } from "../components/metrics";
import { BreachesList, PaymentsList } from "../components/History";
import { useSystemSnapshot } from "../hooks/useReads";
import { usePayments, useRatioBreaches } from "../hooks/usePonder";
import { BANKS } from "../lib/directory";
import { Badge } from "../components/ui";

/** Public read-only dashboard: every metric, no actions. `joinSlot` carries the Option B card. */
export function ObserverView({ joinSlot }: { joinSlot?: ReactNode }) {
  const s = useSystemSnapshot();
  const payments = usePayments({ limit: 15 });
  const breaches = useRatioBreaches({ limit: 10 });

  const totalM1 = s.bankA.m1 !== undefined && s.bankB.m1 !== undefined ? s.bankA.m1 + s.bankB.m1 : undefined;

  return (
    <div className="stack">
      {joinSlot}

      <Card title="Agrégats monétaires">
        <div className="stat-grid">
          <Stat label="M0 — monnaie centrale (wCBDC)" value={<Amount value={s.m0} symbol="wCBDC" />} />
          <Stat label="M1 — Banque A (DEP-A)" value={<Amount value={s.bankA.m1} symbol="DEP-A" />} />
          <Stat label="M1 — Banque B (DEP-B)" value={<Amount value={s.bankB.m1} symbol="DEP-B" />} />
          <Stat label="M1 total" value={<Amount value={totalM1} />} />
          <Stat label="sEUR en circulation" value={<Amount value={s.stable.supply} symbol="sEUR" />} />
          <Stat
            label="Seuil réglementaire"
            value={<Percent bps={s.thresholdBps} />}
            hint="ratio de réserves minimal"
          />
        </div>
        <p className="note">
          wCBDC = euros de banque centrale · DEP-A/DEP-B = euros de banque commerciale (dépôts tokenisés) · sEUR =
          stablecoin adossé aux dépôts.
        </p>
      </Card>

      <div className="grid-2">
        {(["A", "B"] as const).map((key) => {
          const bank = key === "A" ? s.bankA : s.bankB;
          return (
            <Card
              key={key}
              title={BANKS[key].label}
              actions={
                <HealthBadge ratioBps={bank.ratioBps} thresholdBps={s.thresholdBps} reserves={bank.reserves} />
              }
            >
              <div className="stat-grid">
                <Stat label="Réserves (wCBDC)" value={<Amount value={bank.reserves} />} />
                <Stat label={`Dépôts (${BANKS[key].depSymbol})`} value={<Amount value={bank.m1} />} />
                <Stat label="Ratio de réserves" value={<Percent bps={bank.ratioBps} />} />
                <Stat label="État du dépôt" value={bank.paused ? <Badge tone="bad">Gelé</Badge> : <Badge tone="good">Actif</Badge>} />
              </div>
              <RatioGauge ratioBps={bank.ratioBps} thresholdBps={s.thresholdBps} />
            </Card>
          );
        })}
      </div>

      <Card
        title="StableCo — preuve de réserves"
        actions={s.stable.paused ? <Badge tone="warn">Mint/redeem en pause</Badge> : <Badge tone="good">Actif</Badge>}
      >
        <div className="stat-grid">
          <Stat label="Réserves (DEP-A)" value={<Amount value={s.stable.reserves} symbol="DEP-A" />} />
          <Stat label="sEUR émis" value={<Amount value={s.stable.supply} symbol="sEUR" />} />
          <Stat label="Couverture" value={<Percent bps={s.stable.coverageBps} />} hint="≥ 100 % attendu" />
        </div>
      </Card>

      <Card title="Derniers paiements">
        <PaymentsList rows={payments.data} />
      </Card>

      <Card title="Mur d'alertes — ratio de réserves">
        <BreachesList rows={breaches.data} />
      </Card>
    </div>
  );
}

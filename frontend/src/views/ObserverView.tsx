import type { ReactNode } from "react";
import { Badge, Card, Stat } from "../components/ui";
import { Amount, HealthBadge, Percent, RatioGauge } from "../components/metrics";
import { BreachesList, PaymentsList } from "../components/History";
import { useSystemSnapshot } from "../hooks/useReads";
import { usePayments, useRatioBreaches } from "../hooks/usePonder";
import { BANKS } from "../lib/directory";

/** Public read-only dashboard: every metric, no actions. `joinSlot` carries the Option B card. */
export function ObserverView({ joinSlot }: { joinSlot?: ReactNode }) {
  const s = useSystemSnapshot();
  const payments = usePayments({ limit: 15 });
  const breaches = useRatioBreaches({ limit: 10 });

  const totalM1 = s.bankA.m1 !== undefined && s.bankB.m1 !== undefined ? s.bankA.m1 + s.bankB.m1 : undefined;

  return (
    <div className="stack">
      {joinSlot}

      <Card title="Monetary aggregates">
        <div className="stat-grid">
          <Stat label="M0 — central-bank money (wCBDC)" value={<Amount value={s.m0} symbol="wCBDC" />} />
          <Stat label="M1 — Bank A (DEP-A)" value={<Amount value={s.bankA.m1} symbol="DEP-A" />} />
          <Stat label="M1 — Bank B (DEP-B)" value={<Amount value={s.bankB.m1} symbol="DEP-B" />} />
          <Stat label="Total M1" value={<Amount value={totalM1} />} />
          <Stat label="sEUR in circulation" value={<Amount value={s.stable.supply} symbol="sEUR" />} />
          <Stat label="Regulatory threshold" value={<Percent bps={s.thresholdBps} />} hint="minimum reserve ratio" />
        </div>
        <p className="note">
          wCBDC = central-bank euros · DEP-A/DEP-B = commercial-bank euros (tokenized deposits) · sEUR = a stablecoin
          backed by deposits.
        </p>
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
                <Stat label="Reserve ratio" value={<Percent bps={bank.ratioBps} />} />
                <Stat
                  label="Deposit status"
                  value={bank.paused ? <Badge tone="bad">Frozen</Badge> : <Badge tone="good">Active</Badge>}
                />
              </div>
              <RatioGauge ratioBps={bank.ratioBps} thresholdBps={s.thresholdBps} />
            </Card>
          );
        })}
      </div>

      <Card
        title="StableCo — proof of reserves"
        actions={s.stable.paused ? <Badge tone="warn">Mint/redeem paused</Badge> : <Badge tone="good">Active</Badge>}
      >
        <div className="stat-grid">
          <Stat label="Reserves (DEP-A)" value={<Amount value={s.stable.reserves} symbol="DEP-A" />} />
          <Stat label="sEUR issued" value={<Amount value={s.stable.supply} symbol="sEUR" />} />
          <Stat label="Coverage" value={<Percent bps={s.stable.coverageBps} />} hint="≥ 100% expected" />
        </div>
      </Card>

      <Card title="Recent payments">
        <PaymentsList rows={payments.data} />
      </Card>

      <Card title="Alert wall — reserve ratio">
        <BreachesList rows={breaches.data} />
      </Card>
    </div>
  );
}

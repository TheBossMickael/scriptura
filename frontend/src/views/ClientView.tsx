import { useAccount } from "wagmi";
import { Card, Stat } from "../components/ui";
import { Amount, HealthBadge, Percent, RatioGauge } from "../components/metrics";
import { PaymentForm } from "../components/PaymentForm";
import { MintRedeemForm } from "../components/MintRedeemForm";
import { P2PForm } from "../components/P2PForm";
import { PaymentsList, SeurTransfersList, StableFlowsList } from "../components/History";
import { useAccountBalances, useSystemSnapshot } from "../hooks/useReads";
import { usePayments, useSeurTransfers, useStableFlows } from "../hooks/usePonder";
import { BANKS, type BankKey } from "../lib/directory";

export function ClientView({ bankKey }: { bankKey: BankKey }) {
  const { address } = useAccount();
  const bank = BANKS[bankKey];
  const balances = useAccountBalances(address, bank.dep);
  const snapshot = useSystemSnapshot();
  const myBank = bankKey === "A" ? snapshot.bankA : snapshot.bankB;
  const payments = usePayments(address ? { account: address, limit: 15 } : {});
  const flows = useStableFlows(address ? { account: address, limit: 10 } : {});
  const seurTx = useSeurTransfers(address ? { account: address, limit: 10 } : {});

  if (!address) return null;

  return (
    <div className="stack">
      <div className="grid-2">
        <Card title="My balances" subtitle={`Client of ${bank.label}`}>
          <div className="stat-grid">
            <Stat label={bank.depSymbol} value={<Amount value={balances.dep} symbol={bank.depSymbol} />} />
            <Stat label="sEUR" value={<Amount value={balances.seur} symbol="sEUR" />} />
          </div>
          <p className="note">
            {bank.depSymbol} = your euros deposited at {bank.label} (commercial-bank money). sEUR = a stablecoin backed
            by those deposits.
          </p>
        </Card>
        <Card
          title={`${bank.label} health`}
          actions={<HealthBadge ratioBps={myBank.ratioBps} thresholdBps={snapshot.thresholdBps} reserves={myBank.reserves} />}
        >
          <div className="stat-grid">
            <Stat label="Reserves (wCBDC)" value={<Amount value={myBank.reserves} />} />
            <Stat label="Reserve ratio" value={<Percent bps={myBank.ratioBps} />} />
          </div>
          <RatioGauge ratioBps={myBank.ratioBps} thresholdBps={snapshot.thresholdBps} />
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Pay">
          <PaymentForm account={address} bankKey={bankKey} depBalance={balances.dep} />
        </Card>
        <div className="stack">
          <Card title="sEUR stablecoin — mint / redeem">
            <MintRedeemForm account={address} bankKey={bankKey} depBalance={balances.dep} seurBalance={balances.seur} />
          </Card>
          <Card title="sEUR transfer (P2P)">
            <P2PForm account={address} seurBalance={balances.seur} />
          </Card>
        </div>
      </div>

      <Card title="My payment history">
        <PaymentsList rows={payments.data} empty="No payments yet." />
      </Card>

      <div className="grid-2">
        <Card title="My sEUR mint / redeem">
          <StableFlowsList rows={flows.data} empty="No mint/redeem." />
        </Card>
        <Card title="My sEUR transfers">
          <SeurTransfersList rows={seurTx.data} empty="No sEUR transfers." />
        </Card>
      </div>
    </div>
  );
}

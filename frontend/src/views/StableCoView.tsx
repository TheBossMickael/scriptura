import { Badge, Button, Card, Stat } from "../components/ui";
import { Amount, Percent } from "../components/metrics";
import { StableFlowsList } from "../components/History";
import { TxStatus } from "../components/TxStatus";
import { ReadOnlyBanner } from "../components/Explore";
import { useTx } from "../hooks/useActions";
import { useSystemSnapshot } from "../hooks/useReads";
import { useSeurHolders, useStableFlows } from "../hooks/usePonder";
import { stableCoAbi } from "../lib/abis";
import { deployment, labelForAddress } from "../lib/directory";
import { formatAmount } from "../lib/format";
import { isFullyCovered } from "../lib/metrics";

export function StableCoView({ readOnly }: { readOnly?: boolean }) {
  const snapshot = useSystemSnapshot();
  const holders = useSeurHolders({ limit: 20 });
  const flows = useStableFlows({ limit: 25 });
  const { direct, feedback, isBusy } = useTx();

  const coverageBps = snapshot.stable.coverageBps;
  const covered = coverageBps !== undefined && isFullyCovered(coverageBps);

  return (
    <div className="stack">
      {readOnly && <ReadOnlyBanner role="StableCo operator" />}
      <Card
        title="StableCo — proof of reserves"
        actions={
          coverageBps === undefined ? (
            <Badge>—</Badge>
          ) : covered ? (
            <Badge tone="good">Covered ≥ 100%</Badge>
          ) : (
            <Badge tone="bad">Under-collateralized</Badge>
          )
        }
      >
        <div className="stat-grid">
          <Stat label="Reserves (DEP-A)" value={<Amount value={snapshot.stable.reserves} symbol="DEP-A" />} />
          <Stat label="sEUR issued" value={<Amount value={snapshot.stable.supply} symbol="sEUR" />} />
          <Stat label="Coverage" value={<Percent bps={coverageBps} />} hint="reserves / supply, ≥ 100%" />
          <Stat
            label="Issuance"
            value={snapshot.stable.paused ? <Badge tone="warn">Paused</Badge> : <Badge tone="good">Active</Badge>}
          />
        </div>
        <p className="note">
          Supply is endogenous: no admin mint. The operator's only power is to pause mint/redeem.
        </p>
        <div className="btn-row">
          {snapshot.stable.paused ? (
            <Button
              onClick={() =>
                direct("Resume issuance", { address: deployment.stableCo, abi: stableCoAbi, functionName: "unpause" })
              }
              disabled={isBusy}
            >
              Resume (unpause)
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={() =>
                direct("Pause issuance", { address: deployment.stableCo, abi: stableCoAbi, functionName: "pause" })
              }
              disabled={isBusy}
            >
              Pause
            </Button>
          )}
        </div>
        <TxStatus feedback={feedback} />
      </Card>

      <div className="grid-2">
        <Card title="sEUR holders">
          {!holders.data ? (
            <p className="muted">Indexer unavailable.</p>
          ) : holders.data.length === 0 ? (
            <p className="muted">No holders.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Holder</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {holders.data.map((h) => (
                  <tr key={h.address}>
                    <td>{labelForAddress(h.address)}</td>
                    <td className="num">{formatAmount(BigInt(h.balance))} sEUR</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Mint / redeem volumes">
          <StableFlowsList rows={flows.data} />
        </Card>
      </div>
    </div>
  );
}

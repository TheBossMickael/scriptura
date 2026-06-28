import { Badge, Button, Card, Stat } from "../components/ui";
import { Amount, Percent } from "../components/metrics";
import { StableFlowsList } from "../components/History";
import { TxStatus } from "../components/TxStatus";
import { useTx } from "../hooks/useActions";
import { useSystemSnapshot } from "../hooks/useReads";
import { useSeurHolders, useStableFlows } from "../hooks/usePonder";
import { stableCoAbi } from "../lib/abis";
import { deployment, labelForAddress } from "../lib/directory";
import { formatAmount } from "../lib/format";
import { isFullyCovered } from "../lib/metrics";

export function StableCoView() {
  const snapshot = useSystemSnapshot();
  const holders = useSeurHolders({ limit: 20 });
  const flows = useStableFlows({ limit: 25 });
  const { direct, feedback, isBusy } = useTx();

  const coverageBps = snapshot.stable.coverageBps;
  const covered = coverageBps !== undefined && isFullyCovered(coverageBps);

  return (
    <div className="stack">
      <Card
        title="StableCo — preuve de réserves"
        actions={
          coverageBps === undefined ? (
            <Badge>—</Badge>
          ) : covered ? (
            <Badge tone="good">Couvert à 100 %+</Badge>
          ) : (
            <Badge tone="bad">Sous-couvert</Badge>
          )
        }
      >
        <div className="stat-grid">
          <Stat label="Réserves (DEP-A)" value={<Amount value={snapshot.stable.reserves} symbol="DEP-A" />} />
          <Stat label="sEUR émis" value={<Amount value={snapshot.stable.supply} symbol="sEUR" />} />
          <Stat label="Couverture" value={<Percent bps={coverageBps} />} hint="réserves / supply, ≥ 100 %" />
          <Stat
            label="Émission"
            value={snapshot.stable.paused ? <Badge tone="warn">En pause</Badge> : <Badge tone="good">Active</Badge>}
          />
        </div>
        <p className="note">
          La supply est endogène : aucun mint admin. Le seul pouvoir de l'opérateur est de suspendre mint/redeem.
        </p>
        <div className="btn-row">
          {snapshot.stable.paused ? (
            <Button
              onClick={() =>
                direct("Reprendre l'émission", {
                  address: deployment.stableCo,
                  abi: stableCoAbi,
                  functionName: "unpause",
                })
              }
              disabled={isBusy}
            >
              Reprendre (unpause)
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={() =>
                direct("Suspendre l'émission", {
                  address: deployment.stableCo,
                  abi: stableCoAbi,
                  functionName: "pause",
                })
              }
              disabled={isBusy}
            >
              Suspendre (pause)
            </Button>
          )}
        </div>
        <TxStatus feedback={feedback} />
      </Card>

      <div className="grid-2">
        <Card title="Détenteurs de sEUR">
          {!holders.data ? (
            <p className="muted">Indexeur indisponible.</p>
          ) : holders.data.length === 0 ? (
            <p className="muted">Aucun détenteur.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Détenteur</th>
                  <th className="num">Solde</th>
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

        <Card title="Volumes mint / redeem">
          <StableFlowsList rows={flows.data} />
        </Card>
      </div>
    </div>
  );
}

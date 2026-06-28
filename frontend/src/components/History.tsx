import { labelForAddress } from "../lib/directory";
import { formatAmount, formatPercentFromBps } from "../lib/format";
import type { PaymentRow, RatioBreachRow, SeurTransferRow, StableFlowRow } from "../lib/ponder";

function ts(sec: string): string {
  return new Date(Number(sec) * 1000).toLocaleString("fr-FR");
}

function Unavailable() {
  return <p className="muted">Indexeur indisponible (lancez l'indexeur Ponder).</p>;
}

export function PaymentsList({ rows, empty }: { rows: PaymentRow[] | undefined; empty?: string }) {
  if (!rows) return <Unavailable />;
  if (rows.length === 0) return <p className="muted">{empty ?? "Aucun paiement."}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Quand</th>
          <th>De</th>
          <th>Vers</th>
          <th>Type</th>
          <th className="num">Montant</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{ts(r.timestamp)}</td>
            <td>{labelForAddress(r.sender)}</td>
            <td>{labelForAddress(r.recipient)}</td>
            <td>{r.kind === "interbank" ? "Interbancaire" : "Intrabancaire"}</td>
            <td className="num">{formatAmount(BigInt(r.amount))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StableFlowsList({ rows, empty }: { rows: StableFlowRow[] | undefined; empty?: string }) {
  if (!rows) return <Unavailable />;
  if (rows.length === 0) return <p className="muted">{empty ?? "Aucun mouvement sEUR."}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Quand</th>
          <th>Compte</th>
          <th>Type</th>
          <th className="num">Montant</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{ts(r.timestamp)}</td>
            <td>{labelForAddress(r.account)}</td>
            <td>{r.kind === "mint" ? "Mint" : "Redeem"}</td>
            <td className="num">{formatAmount(BigInt(r.amount))} sEUR</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BreachesList({ rows }: { rows: RatioBreachRow[] | undefined }) {
  if (!rows) return <Unavailable />;
  if (rows.length === 0) return <p className="muted">Aucune alerte de ratio.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Quand</th>
          <th>Banque</th>
          <th className="num">Ratio</th>
          <th className="num">Seuil</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{ts(r.timestamp)}</td>
            <td>{labelForAddress(r.bank)}</td>
            <td className="num">{formatPercentFromBps(BigInt(r.ratioBps))}</td>
            <td className="num">{formatPercentFromBps(BigInt(r.thresholdBps))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SeurTransfersList({ rows, empty }: { rows: SeurTransferRow[] | undefined; empty?: string }) {
  if (!rows) return <Unavailable />;
  if (rows.length === 0) return <p className="muted">{empty ?? "Aucun transfert sEUR."}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Quand</th>
          <th>De</th>
          <th>Vers</th>
          <th className="num">Montant</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{ts(r.timestamp)}</td>
            <td>{labelForAddress(r.sender)}</td>
            <td>{labelForAddress(r.recipient)}</td>
            <td className="num">{formatAmount(BigInt(r.amount))} sEUR</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

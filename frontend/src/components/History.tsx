import { labelForAddress } from "../lib/directory";
import { formatAmount, formatPercentFromBps } from "../lib/format";
import type { PaymentRow, RatioBreachRow, SeurTransferRow, StableFlowRow } from "../lib/ponder";

function ts(sec: string): string {
  return new Date(Number(sec) * 1000).toLocaleString("en-US");
}

function Unavailable() {
  return <p className="muted">Indexer unavailable (start the Ponder indexer).</p>;
}

export function PaymentsList({ rows, empty }: { rows: PaymentRow[] | undefined; empty?: string }) {
  if (!rows) return <Unavailable />;
  if (rows.length === 0) return <p className="muted">{empty ?? "No payments."}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>From</th>
          <th>To</th>
          <th>Type</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{ts(r.timestamp)}</td>
            <td>{labelForAddress(r.sender)}</td>
            <td>{labelForAddress(r.recipient)}</td>
            <td>{r.kind === "interbank" ? "Interbank" : "Intrabank"}</td>
            <td className="num">{formatAmount(BigInt(r.amount))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StableFlowsList({ rows, empty }: { rows: StableFlowRow[] | undefined; empty?: string }) {
  if (!rows) return <Unavailable />;
  if (rows.length === 0) return <p className="muted">{empty ?? "No sEUR movements."}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>Account</th>
          <th>Type</th>
          <th className="num">Amount</th>
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
  if (rows.length === 0) return <p className="muted">No ratio alerts.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>Bank</th>
          <th className="num">Ratio</th>
          <th className="num">Threshold</th>
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
  if (rows.length === 0) return <p className="muted">{empty ?? "No sEUR transfers."}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>From</th>
          <th>To</th>
          <th className="num">Amount</th>
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

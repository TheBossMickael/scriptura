import { Spinner } from "./ui";
import { explorerTxUrl } from "../lib/wagmi";
import { shortAddress } from "../lib/format";
import type { TxFeedback } from "../hooks/useActions";
import type { Hex } from "viem";

/** Renders a tx hash as an Etherscan link (Sepolia) or the short hash (Anvil). */
function HashLink({ hash, label }: { hash: Hex; label: string }) {
  const url = explorerTxUrl(hash);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  ) : (
    <code>{shortAddress(hash)}</code>
  );
}

/**
 * In-section action status: a loading line while the tx mines (matters on Sepolia) — with the
 * hash/link as soon as it's known — then the confirmed result. Persists ~30s.
 */
export function TxStatus({ feedback }: { feedback: TxFeedback }) {
  if (feedback.status === "idle") return null;

  if (feedback.status === "pending") {
    return (
      <div className="txstatus txstatus-pending">
        <Spinner />
        <span>
          {feedback.label} — transaction en cours…
          {feedback.hash ? <> · <HashLink hash={feedback.hash} label="suivre" /></> : null}
        </span>
      </div>
    );
  }

  if (feedback.status === "error") {
    return (
      <div className="txstatus txstatus-error">
        <span>
          ✗ {feedback.label} — {feedback.message}
        </span>
      </div>
    );
  }

  return (
    <div className="txstatus txstatus-done">
      <span>
        ✓ {feedback.label} — confirmé · <HashLink hash={feedback.hash} label="voir la transaction" />
      </span>
    </div>
  );
}

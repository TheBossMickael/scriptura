import { Badge } from "./ui";
import { bankHealth, HEALTH_EMOJI, HEALTH_LABEL } from "../lib/metrics";
import { formatAmount, formatPercentFromBps, isUnboundedRatio } from "../lib/format";

/** Shimmer placeholder shown while an on-chain read is loading. */
function Skeleton() {
  return <span className="skeleton" aria-hidden="true" />;
}

export function Amount({ value, symbol }: { value: bigint | undefined; symbol?: string }) {
  if (value === undefined) return <Skeleton />;
  return (
    <span className="amount">
      {formatAmount(value)}
      {symbol ? <span className="amount-symbol"> {symbol}</span> : null}
    </span>
  );
}

export function Percent({ bps }: { bps: bigint | undefined }) {
  if (bps === undefined) return <Skeleton />;
  return <span>{formatPercentFromBps(bps)}</span>;
}

export function HealthBadge({
  ratioBps,
  thresholdBps,
  reserves,
}: {
  ratioBps: bigint | undefined;
  thresholdBps: bigint | undefined;
  reserves: bigint | undefined;
}) {
  if (ratioBps === undefined || thresholdBps === undefined || reserves === undefined) {
    return <Badge>—</Badge>;
  }
  const health = bankHealth(ratioBps, thresholdBps, reserves);
  const tone = health === "HEALTHY" ? "good" : health === "STRESSED" ? "warn" : "bad";
  return (
    <Badge tone={tone}>
      {HEALTH_EMOJI[health]} {HEALTH_LABEL[health]}
    </Badge>
  );
}

/** Horizontal gauge: ratio vs the regulatory threshold (display scale capped at 25%). */
export function RatioGauge({ ratioBps, thresholdBps }: { ratioBps: bigint | undefined; thresholdBps: bigint | undefined }) {
  if (ratioBps === undefined || thresholdBps === undefined) return <div className="gauge gauge-empty" />;
  const scaleMaxPct = 25;
  const ratioPct = isUnboundedRatio(ratioBps) ? scaleMaxPct : Number(ratioBps) / 100;
  const thresholdPct = Number(thresholdBps) / 100;
  const fill = Math.min(100, (ratioPct / scaleMaxPct) * 100);
  const markerLeft = Math.min(100, (thresholdPct / scaleMaxPct) * 100);
  const below = ratioPct < thresholdPct;
  return (
    <div className="gauge" title={`Ratio ${formatPercentFromBps(ratioBps)} — seuil ${formatPercentFromBps(thresholdBps)}`}>
      <div className={`gauge-fill ${below ? "gauge-fill-bad" : "gauge-fill-good"}`} style={{ width: `${fill}%` }} />
      <div className="gauge-threshold" style={{ left: `${markerLeft}%` }} />
    </div>
  );
}

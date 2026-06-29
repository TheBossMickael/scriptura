import { ROLE_LABEL, type RoleResolution } from "../lib/roles";

/** Which dashboard to display; "mine" follows the connected wallet's resolved role. */
export type ViewKey = "mine" | "observer" | "bankA" | "bankB" | "stableco" | "centralbank";

/** True when the selected institutional view isn't the one the connected wallet actually holds. */
export function isPreview(view: ViewKey, resolution: RoleResolution): boolean {
  switch (view) {
    case "bankA":
      return !(resolution.role === "bankOperator" && resolution.bankKey === "A");
    case "bankB":
      return !(resolution.role === "bankOperator" && resolution.bankKey === "B");
    case "stableco":
      return resolution.role !== "stableCoOperator";
    case "centralbank":
      return resolution.role !== "centralBankOperator";
    default:
      return false;
  }
}

/** Lets anyone browse any dashboard read-only (data is public; actions stay gated on-chain). */
export function ViewSwitcher({
  value,
  onChange,
  resolution,
  isConnected,
}: {
  value: ViewKey;
  onChange: (view: ViewKey) => void;
  resolution: RoleResolution;
  isConnected: boolean;
}) {
  const mineLabel = isConnected
    ? `My view — ${ROLE_LABEL[resolution.role]}${resolution.bankKey ? ` ${resolution.bankKey}` : ""}`
    : "My view — Observer";

  return (
    <div className="viewbar">
      <span className="viewbar-label">Explore as</span>
      <select value={value} onChange={(e) => onChange(e.target.value as ViewKey)}>
        <option value="mine">{mineLabel}</option>
        <option value="observer">Observer</option>
        <option value="bankA">Bank A — operator</option>
        <option value="bankB">Bank B — operator</option>
        <option value="stableco">StableCo</option>
        <option value="centralbank">Central bank</option>
      </select>
    </div>
  );
}

/** Banner shown atop an institutional view being previewed without holding its role. */
export function ReadOnlyBanner({ role }: { role: string }) {
  return <div className="readonly-banner">Read-only preview — connect the {role} account to act.</div>;
}

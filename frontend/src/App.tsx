import { Fragment, useState } from "react";
import { Header } from "./components/Header";
import { Card } from "./components/ui";
import { JoinCard } from "./components/Join";
import { ViewSwitcher, isPreview, type ViewKey } from "./components/Explore";
import { ObserverView } from "./views/ObserverView";
import { ClientView } from "./views/ClientView";
import { BankOperatorView } from "./views/BankOperatorView";
import { StableCoView } from "./views/StableCoView";
import { CentralBankView } from "./views/CentralBankView";
import { useRole } from "./hooks/useRole";
import { useChainWatcher } from "./hooks/useChainWatcher";
import { chainName, deploymentComplete, missingContracts } from "./lib/directory";
import type { RoleResolution } from "./lib/roles";
import type { Address } from "viem";

function DeploymentIncomplete() {
  return (
    <Card title="Incomplete deployment">
      <p>
        Missing addresses in <code>deployments/{chainName}.json</code>: {missingContracts.join(", ") || "—"}.
      </p>
      <p>
        Run <code>make deploy-{chainName}</code> first to generate a complete file, then restart the dev server.
      </p>
    </Card>
  );
}

/** The connected wallet's own resolved view (with the Option B Join card when relevant). */
function renderOwnView(resolution: RoleResolution, address: Address | undefined, isConnected: boolean) {
  switch (resolution.role) {
    case "client":
      return resolution.bankKey ? <ClientView bankKey={resolution.bankKey} /> : <ObserverView />;
    case "bankOperator":
      return resolution.bankKey ? <BankOperatorView bankKey={resolution.bankKey} /> : <ObserverView />;
    case "stableCoOperator":
      return <StableCoView />;
    case "centralBankOperator":
      return <CentralBankView />;
    case "observer":
    default:
      return <ObserverView joinSlot={isConnected && address ? <JoinCard account={address} /> : undefined} />;
  }
}

/** The selected dashboard — "mine" follows the resolved role; others are read-only previews. */
function renderSelectedView(
  view: ViewKey,
  resolution: RoleResolution,
  address: Address | undefined,
  isConnected: boolean,
) {
  switch (view) {
    case "observer":
      return <ObserverView />;
    case "bankA":
      return <BankOperatorView bankKey="A" readOnly={isPreview("bankA", resolution)} />;
    case "bankB":
      return <BankOperatorView bankKey="B" readOnly={isPreview("bankB", resolution)} />;
    case "stableco":
      return <StableCoView readOnly={isPreview("stableco", resolution)} />;
    case "centralbank":
      return <CentralBankView readOnly={isPreview("centralbank", resolution)} />;
    case "mine":
    default:
      return renderOwnView(resolution, address, isConnected);
  }
}

export function App() {
  const { resolution, address, isConnected, isLoading } = useRole();
  const [view, setView] = useState<ViewKey>("mine");
  useChainWatcher();

  const ready = deploymentComplete && !isLoading;

  return (
    <div className="app">
      <Header resolution={resolution} />
      {ready && <ViewSwitcher value={view} onChange={setView} resolution={resolution} isConnected={isConnected} />}
      <main className="container">
        {!deploymentComplete ? (
          <DeploymentIncomplete />
        ) : isLoading ? (
          <Card title="Loading">
            <p>Resolving role…</p>
          </Card>
        ) : (
          // Key by view AND account: bank A → bank B reuses the same component type, and React
          // would keep its local state (form inputs, TxStatus feedback) across the switch — a
          // stale error from view A must not survive into view B, nor across wallet changes.
          <Fragment key={`${view}:${address ?? "none"}`}>
            {renderSelectedView(view, resolution, address, isConnected)}
          </Fragment>
        )}
      </main>
    </div>
  );
}

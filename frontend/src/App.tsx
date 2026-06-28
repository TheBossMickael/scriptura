import { Header } from "./components/Header";
import { Card } from "./components/ui";
import { JoinCard } from "./components/Join";
import { ObserverView } from "./views/ObserverView";
import { ClientView } from "./views/ClientView";
import { BankOperatorView } from "./views/BankOperatorView";
import { StableCoView } from "./views/StableCoView";
import { CentralBankView } from "./views/CentralBankView";
import { useRole } from "./hooks/useRole";
import { useChainWatcher } from "./hooks/useChainWatcher";
import { deploymentComplete, missingContracts } from "./lib/directory";
import type { RoleResolution } from "./lib/roles";
import type { Address } from "viem";

function DeploymentIncomplete() {
  return (
    <Card title="Déploiement incomplet">
      <p>
        Adresses manquantes dans <code>deployments/local.json</code> : {missingContracts.join(", ") || "—"}.
      </p>
      <p>
        Lance d'abord <code>make deploy-local</code> (avec Anvil) pour générer un fichier complet, puis relance le
        serveur de dev.
      </p>
    </Card>
  );
}

function renderView(resolution: RoleResolution, address: Address | undefined, isConnected: boolean) {
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

export function App() {
  const { resolution, address, isConnected, isLoading } = useRole();
  useChainWatcher();
  return (
    <div className="app">
      <Header resolution={resolution} />
      <main className="container">
        {!deploymentComplete ? (
          <DeploymentIncomplete />
        ) : isLoading ? (
          <Card title="Chargement">
            <p>Résolution du rôle…</p>
          </Card>
        ) : (
          renderView(resolution, address, isConnected)
        )}
      </main>
    </div>
  );
}

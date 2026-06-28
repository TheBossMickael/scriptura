import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { Badge, Button } from "./ui";
import { ROLE_LABEL, type RoleResolution } from "../lib/roles";
import { expectedChainId, labelForAddress } from "../lib/directory";
import { targetChain } from "../lib/wagmi";
import { usePending } from "../pending/PendingProvider";

export function Header({ resolution }: { resolution: RoleResolution }) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { isBusy } = usePending();

  const injected = connectors[0];
  const wrongNetwork = isConnected && chainId !== expectedChainId;
  const roleLabel = `${ROLE_LABEL[resolution.role]}${resolution.bankKey ? ` ${resolution.bankKey}` : ""}`;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">€</span>
        <div>
          <h1>Two-Tier Money Sandbox</h1>
          <p className="brand-sub">Monnaie centrale · dépôts · stablecoin — règlement atomique</p>
        </div>
      </div>

      <div className="topbar-right">
        {isConnected && <Badge tone="neutral">{roleLabel}</Badge>}
        {wrongNetwork && (
          <Button variant="danger" disabled={isBusy} onClick={() => switchChain({ chainId: targetChain.id })}>
            Basculer sur {targetChain.name}
          </Button>
        )}
        {isConnected ? (
          <>
            <span className="addr" title={address}>
              {labelForAddress(address)}
            </span>
            <Button variant="ghost" disabled={isBusy} onClick={() => disconnect()}>
              Déconnecter
            </Button>
          </>
        ) : (
          <Button onClick={() => injected && connect({ connector: injected })} disabled={!injected || isPending || isBusy}>
            {isPending ? "Connexion…" : "Connecter MetaMask"}
          </Button>
        )}
      </div>
    </header>
  );
}

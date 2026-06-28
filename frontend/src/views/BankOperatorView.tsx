import { useState } from "react";
import { useReadContract, useWriteContract } from "wagmi";
import type { Address } from "viem";
import { Badge, Button, Card, Field, Stat } from "../components/ui";
import { Amount, HealthBadge, Percent, RatioGauge } from "../components/metrics";
import { PaymentsList } from "../components/History";
import { TxStatus } from "../components/TxStatus";
import { useTx } from "../hooks/useActions";
import { useSystemSnapshot } from "../hooks/useReads";
import { useClients, usePayments } from "../hooks/usePonder";
import { commercialBankAbi, depositTokenAbi } from "../lib/abis";
import { BANKS, labelForAddress, type BankInfo, type BankKey } from "../lib/directory";
import { looksLikeAddress, parseAmount } from "../lib/format";

// Genesis convention (documented, non-tokenized): each bank's balance sheet carries 3,500,000
// in "loans" so that assets (reserves + loans) == deposits at genesis. Not updated by credits.
const GENESIS_LOANS = 3_500_000_000_000n;

function ClientRow({
  bank,
  address,
  onRemove,
  disabled,
}: {
  bank: BankInfo;
  address: Address;
  onRemove: (address: Address) => void;
  disabled: boolean;
}) {
  const balance = useReadContract({
    address: bank.dep,
    abi: depositTokenAbi,
    functionName: "balanceOf",
    args: [address],
    query: { refetchInterval: 15_000 },
  });

  return (
    <tr>
      <td>{labelForAddress(address)}</td>
      <td className="num">
        <Amount value={balance.data} symbol={bank.depSymbol} />
      </td>
      <td>
        <Button variant="ghost" disabled={disabled} onClick={() => onRemove(address)}>
          Retirer
        </Button>
      </td>
    </tr>
  );
}

function ClientsCard({ bank }: { bank: BankInfo }) {
  const clients = useClients({ bank: bank.bank });
  const { direct, feedback, isBusy } = useTx();

  const onRemove = (address: Address) =>
    direct("Retirer un client", {
      address: bank.bank,
      abi: commercialBankAbi,
      functionName: "removeClient",
      args: [address],
    });

  return (
    <Card title="Clients enregistrés">
      {!clients.data ? (
        <p className="muted">Indexeur indisponible.</p>
      ) : clients.data.length === 0 ? (
        <p className="muted">Aucun client.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Client</th>
              <th className="num">Solde</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.data.map((c) => (
              <ClientRow key={c.address} bank={bank} address={c.address} onRemove={onRemove} disabled={isBusy} />
            ))}
          </tbody>
        </table>
      )}
      <p className="note">Un client ne peut être retiré que si son solde DEP est à zéro.</p>
      <TxStatus feedback={feedback} />
    </Card>
  );
}

function AddClientForm({ bank }: { bank: BankInfo }) {
  const { run, simulate, confirm, feedback, isBusy } = useTx();
  const { writeContractAsync } = useWriteContract();
  const [addr, setAddr] = useState("");
  const [credit, setCredit] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onAdd() {
    setError(null);
    if (!looksLikeAddress(addr)) return setError("Adresse invalide.");
    let amount = 0n;
    if (credit.trim()) {
      try {
        amount = parseAmount(credit);
      } catch {
        return setError("Montant de crédit invalide.");
      }
    }
    const client = addr.trim() as Address;
    const ok = await run("Ajouter un client", async (onHash) => {
      await simulate({ address: bank.bank, abi: commercialBankAbi, functionName: "registerClient", args: [client] });
      const h1 = await writeContractAsync({
        address: bank.bank,
        abi: commercialBankAbi,
        functionName: "registerClient",
        args: [client],
      });
      onHash(h1);
      await confirm(h1);
      if (amount > 0n) {
        await simulate({ address: bank.bank, abi: commercialBankAbi, functionName: "creditClient", args: [client, amount] });
        const h2 = await writeContractAsync({
          address: bank.bank,
          abi: commercialBankAbi,
          functionName: "creditClient",
          args: [client, amount],
        });
        onHash(h2);
        await confirm(h2);
        return h2;
      }
      return h1;
    });
    if (ok) {
      setAddr("");
      setCredit("");
    }
  }

  return (
    <Card title="Ajouter un client">
      <Field label="Adresse du client">
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" disabled={isBusy} />
      </Field>
      <Field label="Crédit initial (optionnel)">
        <input value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="ex. 100000" disabled={isBusy} inputMode="decimal" />
      </Field>
      {error && <p className="note note-bad">{error}</p>}
      <div className="btn-row">
        <Button onClick={onAdd} disabled={isBusy || !addr}>
          Enregistrer{credit.trim() ? " + créditer" : ""}
        </Button>
      </div>
      <TxStatus feedback={feedback} />
    </Card>
  );
}

export function BankOperatorView({ bankKey }: { bankKey: BankKey }) {
  const bank = BANKS[bankKey];
  const snapshot = useSystemSnapshot();
  const data = bankKey === "A" ? snapshot.bankA : snapshot.bankB;
  const flows = usePayments({ bank: bank.bank, limit: 20 });
  const { direct, feedback, isBusy } = useTx();

  const assetsTotal = data.reserves !== undefined ? data.reserves + GENESIS_LOANS : undefined;

  return (
    <div className="stack">
      <Card
        title={`Bilan — ${bank.label}`}
        actions={<HealthBadge ratioBps={data.ratioBps} thresholdBps={snapshot.thresholdBps} reserves={data.reserves} />}
      >
        <div className="grid-2">
          <div>
            <h3>Actif</h3>
            <div className="stat-grid">
              <Stat label="Réserves (wCBDC)" value={<Amount value={data.reserves} />} />
              <Stat label="Prêts (convention de genèse)" value={<Amount value={GENESIS_LOANS} />} />
              <Stat label="Total actif" value={<Amount value={assetsTotal} />} />
            </div>
          </div>
          <div>
            <h3>Passif</h3>
            <div className="stat-grid">
              <Stat label={`Dépôts (${bank.depSymbol})`} value={<Amount value={data.m1} />} />
              <Stat label="Ratio de réserves" value={<Percent bps={data.ratioBps} />} />
              <Stat label="État" value={data.paused ? <Badge tone="bad">Gelée</Badge> : <Badge tone="good">Active</Badge>} />
            </div>
          </div>
        </div>
        <RatioGauge ratioBps={data.ratioBps} thresholdBps={snapshot.thresholdBps} />
        <p className="note">
          Les DEP sont des euros de banque commerciale tokenisés (passif de la banque). La ligne « Prêts » est une
          convention de genèse non tokenisée (3 500 000), non mise à jour par les crédits en V1.
        </p>
      </Card>

      <Card title="Gel de la banque" subtitle="Suspend tout mouvement de dépôts (le sEUR continue de circuler)">
        <div className="btn-row">
          {data.paused ? (
            <Button
              onClick={() => direct("Dégeler la banque", { address: bank.bank, abi: commercialBankAbi, functionName: "unfreeze" })}
              disabled={isBusy}
            >
              Dégeler
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={() => direct("Geler la banque", { address: bank.bank, abi: commercialBankAbi, functionName: "freeze" })}
              disabled={isBusy}
            >
              Geler
            </Button>
          )}
        </div>
        <TxStatus feedback={feedback} />
      </Card>

      <div className="grid-2">
        <AddClientForm bank={bank} />
        <ClientsCard bank={bank} />
      </div>

      <Card title="Flux entrants / sortants">
        <PaymentsList rows={flows.data} empty="Aucun flux." />
      </Card>
    </div>
  );
}

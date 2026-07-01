import { useState } from "react";
import { useReadContract, useWriteContract } from "wagmi";
import type { Address } from "viem";
import { Badge, Button, Card, Field, Stat } from "../components/ui";
import { Amount, HealthBadge, Percent, RatioGauge } from "../components/metrics";
import { PaymentsList } from "../components/History";
import { TxStatus } from "../components/TxStatus";
import { ReadOnlyBanner } from "../components/Explore";
import { useTx } from "../hooks/useActions";
import { useSystemSnapshot } from "../hooks/useReads";
import { useClients, usePayments } from "../hooks/usePonder";
import { commercialBankAbi, depositTokenAbi } from "../lib/abis";
import { BANKS, labelForAddress, type BankInfo, type BankKey } from "../lib/directory";
import { looksLikeAddress, parseAmount } from "../lib/format";
import { targetChain } from "../lib/wagmi";

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
          Remove
        </Button>
      </td>
    </tr>
  );
}

function ClientsCard({ bank }: { bank: BankInfo }) {
  const clients = useClients({ bank: bank.bank });
  const { direct, feedback, isBusy } = useTx();

  const onRemove = (address: Address) =>
    direct("Remove a client", {
      address: bank.bank,
      abi: commercialBankAbi,
      functionName: "removeClient",
      args: [address],
    });

  return (
    <Card title="Registered clients">
      {!clients.data ? (
        <p className="muted">Indexer unavailable.</p>
      ) : clients.data.length === 0 ? (
        <p className="muted">No clients.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Client</th>
              <th className="num">Balance</th>
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
      <p className="note">A client can only be removed when its DEP balance is zero.</p>
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
    if (!looksLikeAddress(addr)) return setError("Invalid address.");
    let amount = 0n;
    if (credit.trim()) {
      try {
        amount = parseAmount(credit);
      } catch {
        return setError("Invalid credit amount.");
      }
    }
    const client = addr.trim() as Address;
    const ok = await run("Add a client", async (onHash) => {
      await simulate({ address: bank.bank, abi: commercialBankAbi, functionName: "registerClient", args: [client] });
      const h1 = await writeContractAsync({
        address: bank.bank,
        abi: commercialBankAbi,
        functionName: "registerClient",
        args: [client],
        chainId: targetChain.id,
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
          chainId: targetChain.id,
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
    <Card title="Add a client">
      <Field label="Client address">
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" disabled={isBusy} />
      </Field>
      <Field label="Initial credit (optional)">
        <input value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="e.g. 100000" disabled={isBusy} inputMode="decimal" />
      </Field>
      {error && <p className="note note-bad">{error}</p>}
      <div className="btn-row">
        <Button onClick={onAdd} disabled={isBusy || !addr}>
          Register{credit.trim() ? " + credit" : ""}
        </Button>
      </div>
      <TxStatus feedback={feedback} />
    </Card>
  );
}

export function BankOperatorView({ bankKey, readOnly }: { bankKey: BankKey; readOnly?: boolean }) {
  const bank = BANKS[bankKey];
  const snapshot = useSystemSnapshot();
  const data = bankKey === "A" ? snapshot.bankA : snapshot.bankB;
  const flows = usePayments({ bank: bank.bank, limit: 20 });
  const { direct, feedback, isBusy } = useTx();

  const assetsTotal = data.reserves !== undefined ? data.reserves + GENESIS_LOANS : undefined;

  return (
    <div className="stack">
      {readOnly && <ReadOnlyBanner role={`${bank.label} operator`} />}
      <Card
        title={`Balance sheet — ${bank.label}`}
        actions={<HealthBadge ratioBps={data.ratioBps} thresholdBps={snapshot.thresholdBps} reserves={data.reserves} />}
      >
        <div className="grid-2">
          <div>
            <h3>Assets</h3>
            <div className="stat-grid">
              <Stat label="Reserves (wCBDC)" value={<Amount value={data.reserves} />} />
              <Stat label="Loans (genesis convention)" value={<Amount value={GENESIS_LOANS} />} />
              <Stat label="Total assets" value={<Amount value={assetsTotal} />} />
            </div>
          </div>
          <div>
            <h3>Liabilities</h3>
            <div className="stat-grid">
              <Stat label={`Deposits (${bank.depSymbol})`} value={<Amount value={data.m1} />} />
              <Stat label="Reserve ratio" value={<Percent bps={data.ratioBps} />} />
              <Stat label="Status" value={data.paused ? <Badge tone="bad">Frozen</Badge> : <Badge tone="good">Active</Badge>} />
            </div>
          </div>
        </div>
        <RatioGauge ratioBps={data.ratioBps} thresholdBps={snapshot.thresholdBps} />
        <p className="note">
          DEP are tokenized commercial-bank euros (the bank's liability). The “Loans” line is a non-tokenized genesis
          convention (3,500,000), not updated by credits in V1.
        </p>
      </Card>

      <Card title="Freeze the bank" subtitle="Halts all deposit movements (sEUR keeps circulating)">
        <div className="btn-row">
          {data.paused ? (
            <Button
              onClick={() => direct("Unfreeze the bank", { address: bank.bank, abi: commercialBankAbi, functionName: "unfreeze" })}
              disabled={isBusy}
            >
              Unfreeze
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={() => direct("Freeze the bank", { address: bank.bank, abi: commercialBankAbi, functionName: "freeze" })}
              disabled={isBusy}
            >
              Freeze
            </Button>
          )}
        </div>
        <TxStatus feedback={feedback} />
      </Card>

      <div className="grid-2">
        <AddClientForm bank={bank} />
        <ClientsCard bank={bank} />
      </div>

      <Card title="Inflows / outflows">
        <PaymentsList rows={flows.data} empty="No flows." />
      </Card>
    </div>
  );
}

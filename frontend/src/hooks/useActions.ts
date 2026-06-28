import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Abi, Address, Hex } from "viem";
import { usePending } from "../pending/PendingProvider";
import { RelayerError, describeRelayerError, faucet, type RelayerSuccess } from "../lib/relayer";
import type { BankKey } from "../lib/directory";

const RECEIPT_TIMEOUT_MS = 120_000;

/** Per-action feedback shown in-section by <TxStatus>; the hash appears as soon as it's known. */
export type TxFeedback =
  | { status: "idle" }
  | { status: "pending"; label: string; hash?: Hex }
  | { status: "done"; label: string; hash: Hex }
  | { status: "error"; label: string; message: string };

/** A dynamic contract write (built at runtime) for the `direct`/`simulate` paths. */
export interface ContractWrite {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

// Contract custom errors -> friendly French. Surfaced by pre-simulation before sending.
const KNOWN_ERRORS: Record<string, string> = {
  ClientHasBalance: "Le client a encore un solde DEP non nul — videz-le avant de le retirer.",
  AlreadyClient: "Cette adresse est déjà cliente.",
  NotBankClient: "Une des parties n'est pas cliente de sa banque.",
  NotClient: "Adresse non cliente de cette banque.",
  InsufficientReserves: "Réserves de la banque insuffisantes pour ce règlement interbancaire.",
  EnforcedPause: "Opération suspendue (banque gelée ou émission en pause).",
  ThresholdAboveMax: "Seuil au-dessus du maximum autorisé (100 %).",
  FaucetAmountTooHigh: "Montant de faucet au-dessus du plafond.",
  IntentExpired: "Intent expiré — relancez l'opération.",
  InvalidIntentSigner: "Signature de l'intent invalide.",
};

function describeError(err: unknown): string {
  if (err instanceof RelayerError) return describeRelayerError(err);
  if (err instanceof Error) {
    const msg = err.message;
    if (/reject|denied|cancell?ed/i.test(msg)) return "Action refusée dans le wallet.";
    if (/timed out|timeout/i.test(msg)) return "Confirmation trop longue — la transaction est peut-être encore en attente.";
    for (const [name, french] of Object.entries(KNOWN_ERRORS)) {
      if (msg.includes(name)) return french;
    }
    const short = (err as { shortMessage?: string }).shortMessage;
    return short ?? msg.split("\n")[0] ?? "Erreur inconnue";
  }
  return "Erreur inconnue";
}

/**
 * Per-component action runner with its own in-section feedback. Each action: pre-simulates
 * (direct writes) to surface the exact revert reason and avoid a doomed wallet popup, signs/
 * sends, then confirms — detecting on-chain reverts (a mined-but-reverted tx resolves a
 * receipt with status "reverted", it does NOT throw) and timing out so the UI never hangs.
 * Drives the global lock via the PendingProvider; feedback auto-clears after 30s or on account
 * change.
 */
export function useTx() {
  const { run: globalRun, isBusy } = usePending();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [feedback, setFeedback] = useState<TxFeedback>({ status: "idle" });

  useEffect(() => {
    setFeedback({ status: "idle" });
  }, [address]);

  useEffect(() => {
    if (feedback.status === "done" || feedback.status === "error") {
      const timer = setTimeout(() => setFeedback({ status: "idle" }), 30_000);
      return () => clearTimeout(timer);
    }
  }, [feedback]);

  const confirm = useCallback(
    async (hash: Hex): Promise<void> => {
      if (!publicClient) return;
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status !== "success") throw new Error("Transaction rejetée on-chain (revert).");
    },
    [publicClient],
  );

  const simulate = useCallback(
    async (call: ContractWrite): Promise<void> => {
      if (!publicClient) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic, runtime-built call
      await publicClient.simulateContract({ account: address, ...call } as any);
    },
    [publicClient, address],
  );

  const execute = useCallback(
    async (label: string, action: (onHash: (h: Hex) => void) => Promise<Hex>): Promise<boolean> => {
      setFeedback({ status: "pending", label });
      try {
        const hash = await globalRun(() => action((h) => setFeedback({ status: "pending", label, hash: h })));
        setFeedback({ status: "done", label, hash });
        return true;
      } catch (err) {
        setFeedback({ status: "error", label, message: describeError(err) });
        return false;
      }
    },
    [globalRun],
  );

  return {
    feedback,
    isBusy,
    /** Waits for a tx receipt (with timeout) and throws on revert — for multi-step flows. */
    confirm,
    /** Pre-flight a write; throws the decoded revert reason without sending — for multi-step flows. */
    simulate,
    /** Gasless: sign an EIP-712 message, relay it, confirm on-chain. */
    relay: (label: string, sign: () => Promise<Hex>, submit: (signature: Hex) => Promise<RelayerSuccess>) =>
      execute(label, async (onHash) => {
        const signature = await sign();
        const { txHash } = await submit(signature);
        onHash(txHash);
        await confirm(txHash);
        return txHash;
      }),
    /** Direct: pre-simulate then send a wallet-signed transaction, then confirm. */
    direct: (label: string, call: ContractWrite) =>
      execute(label, async (onHash) => {
        await simulate(call);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic, runtime-built call
        const hash = (await writeContractAsync({ ...call } as any)) as Hex;
        onHash(hash);
        await confirm(hash);
        return hash;
      }),
    /** Option B onboarding via the relayer faucet (no client signature). */
    faucetOnboard: (addr: Address, bank: BankKey) =>
      execute("Rejoindre la banque", async (onHash) => {
        const { txHash } = await faucet(addr, bank);
        onHash(txHash);
        await confirm(txHash);
        return txHash;
      }),
    /** Custom multi-step flow (e.g. register + credit): `action` returns the last tx hash. */
    run: (label: string, action: (onHash: (h: Hex) => void) => Promise<Hex>) => execute(label, action),
  };
}

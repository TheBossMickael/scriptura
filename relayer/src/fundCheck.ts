import { formatEther, type Address } from "viem";
import type { ChainContext } from "./chain.js";

export interface FundStatus {
  address: Address;
  balance: bigint;
  minBalance: bigint;
  funded: boolean;
}

/** Reads the relayer's gas balance and compares it to the alert threshold. */
export async function checkFunds(
  publicClient: ChainContext["publicClient"],
  address: Address,
  minBalance: bigint,
): Promise<FundStatus> {
  const balance = await publicClient.getBalance({ address });
  return { address, balance, minBalance, funded: balance >= minBalance };
}

export function describeFunds(status: FundStatus): string {
  const balance = formatEther(status.balance);
  const threshold = formatEther(status.minBalance);
  return status.funded
    ? `relayer ${status.address} balance ${balance} ETH (threshold ${threshold})`
    : `RELAYER UNDERFUNDED: ${status.address} holds ${balance} ETH, below the ${threshold} ETH threshold — top up (make seed) or payments will stall`;
}

/**
 * Periodic fund-check loop: logs a warning whenever the balance sits below the
 * threshold. RPC hiccups are logged and retried at the next tick — the watcher
 * must never crash the relayer.
 */
export function startFundWatcher(
  publicClient: ChainContext["publicClient"],
  address: Address,
  minBalance: bigint,
  intervalMs: number,
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): NodeJS.Timeout {
  const tick = async () => {
    try {
      const status = await checkFunds(publicClient, address, minBalance);
      if (status.funded) {
        log.info(describeFunds(status));
      } else {
        log.warn(describeFunds(status));
      }
    } catch (error) {
      log.error(`fund-check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref(); // never keep the process alive just for the watcher
  return timer;
}

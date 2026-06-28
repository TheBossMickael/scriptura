import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";
import { deployment, OPERATOR_ROLE } from "../lib/directory";
import { centralBankAbi, commercialBankAbi, stableCoAbi } from "../lib/abis";
import { resolveRole, type RoleResolution } from "../lib/roles";

export interface RoleState {
  resolution: RoleResolution;
  address: Address | undefined;
  isConnected: boolean;
  isLoading: boolean;
}

/**
 * Resolves the connected wallet's role from on-chain reads (hasRole / isClient). Re-resolves
 * automatically after an Option B onboarding once the PendingProvider invalidates reads.
 */
export function useRole(): RoleState {
  const { address, isConnected } = useAccount();
  const enabled = Boolean(address);
  const args = address ? ([OPERATOR_ROLE, address] as const) : undefined;
  const clientArgs = address ? ([address] as const) : undefined;

  const cbOp = useReadContract({
    address: deployment.centralBank,
    abi: centralBankAbi,
    functionName: "hasRole",
    args,
    query: { enabled },
  });
  const aOp = useReadContract({
    address: deployment.bankA,
    abi: commercialBankAbi,
    functionName: "hasRole",
    args,
    query: { enabled },
  });
  const bOp = useReadContract({
    address: deployment.bankB,
    abi: commercialBankAbi,
    functionName: "hasRole",
    args,
    query: { enabled },
  });
  const stOp = useReadContract({
    address: deployment.stableCo,
    abi: stableCoAbi,
    functionName: "hasRole",
    args,
    query: { enabled },
  });
  const clientA = useReadContract({
    address: deployment.bankA,
    abi: commercialBankAbi,
    functionName: "isClient",
    args: clientArgs,
    query: { enabled },
  });
  const clientB = useReadContract({
    address: deployment.bankB,
    abi: commercialBankAbi,
    functionName: "isClient",
    args: clientArgs,
    query: { enabled },
  });

  const resolution = resolveRole({
    connected: isConnected,
    isCentralBankOperator: cbOp.data === true,
    isBankAOperator: aOp.data === true,
    isBankBOperator: bOp.data === true,
    isStableCoOperator: stOp.data === true,
    isClientA: clientA.data === true,
    isClientB: clientB.data === true,
  });

  const isLoading = enabled && [cbOp, aOp, bOp, stOp, clientA, clientB].some((r) => r.isLoading);

  return { resolution, address, isConnected, isLoading };
}

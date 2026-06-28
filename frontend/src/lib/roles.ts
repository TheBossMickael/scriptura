import type { BankKey } from "./directory";

/**
 * Role resolution from on-chain reads. Pure and testable: a hook fetches `hasRole`/`isClient`
 * for the connected address and feeds the booleans here. Gating is UX only — every privileged
 * call is enforced by `onlyRole` on-chain (trap #7). A connected-but-unknown wallet is an
 * observer that can self-onboard (Option B).
 */

export type Role = "observer" | "client" | "bankOperator" | "stableCoOperator" | "centralBankOperator";

export interface RoleResolution {
  role: Role;
  bankKey?: BankKey;
}

export interface RoleInputs {
  connected: boolean;
  isCentralBankOperator: boolean;
  isBankAOperator: boolean;
  isBankBOperator: boolean;
  isStableCoOperator: boolean;
  isClientA: boolean;
  isClientB: boolean;
}

export function resolveRole(i: RoleInputs): RoleResolution {
  if (!i.connected) return { role: "observer" };
  if (i.isCentralBankOperator) return { role: "centralBankOperator" };
  if (i.isBankAOperator) return { role: "bankOperator", bankKey: "A" };
  if (i.isBankBOperator) return { role: "bankOperator", bankKey: "B" };
  if (i.isStableCoOperator) return { role: "stableCoOperator" };
  if (i.isClientA) return { role: "client", bankKey: "A" };
  if (i.isClientB) return { role: "client", bankKey: "B" };
  return { role: "observer" };
}

export const ROLE_LABEL: Record<Role, string> = {
  observer: "Observateur",
  client: "Client",
  bankOperator: "Opérateur de banque",
  stableCoOperator: "Opérateur StableCo",
  centralBankOperator: "Banque centrale",
};

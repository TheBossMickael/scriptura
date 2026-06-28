import { describe, expect, it } from "vitest";
import { resolveRole, type RoleInputs } from "./roles";

const base: RoleInputs = {
  connected: true,
  isCentralBankOperator: false,
  isBankAOperator: false,
  isBankBOperator: false,
  isStableCoOperator: false,
  isClientA: false,
  isClientB: false,
};

describe("resolveRole", () => {
  it("is observer when not connected", () => {
    expect(resolveRole({ ...base, connected: false })).toEqual({ role: "observer" });
  });

  it("prioritizes central bank operator over everything", () => {
    expect(resolveRole({ ...base, isCentralBankOperator: true, isClientA: true }).role).toBe("centralBankOperator");
  });

  it("resolves bank A operator", () => {
    expect(resolveRole({ ...base, isBankAOperator: true })).toEqual({ role: "bankOperator", bankKey: "A" });
  });

  it("resolves bank B operator", () => {
    expect(resolveRole({ ...base, isBankBOperator: true })).toEqual({ role: "bankOperator", bankKey: "B" });
  });

  it("resolves StableCo operator", () => {
    expect(resolveRole({ ...base, isStableCoOperator: true }).role).toBe("stableCoOperator");
  });

  it("resolves client A and client B", () => {
    expect(resolveRole({ ...base, isClientA: true })).toEqual({ role: "client", bankKey: "A" });
    expect(resolveRole({ ...base, isClientB: true })).toEqual({ role: "client", bankKey: "B" });
  });

  it("is observer when connected but unknown (Option B candidate)", () => {
    expect(resolveRole(base)).toEqual({ role: "observer" });
  });
});

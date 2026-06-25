# CLAUDE.md — Two-Tier Money Sandbox

## What this project is

An on-chain simulation of the **two-tier monetary system**, deployed on Sepolia: tokenized
central bank money (wCBDC, layer M0), tokenized commercial bank deposits (DEP-A/DEP-B, layer M1),
and a fiat-backed stablecoin (sEUR) whose reserves are tokenized deposits. Interbank payments
settle **atomically in central bank money**. The system demonstrates the *singleness of money*,
fractional-reserve fragility (bank runs), and TradFi→stablecoin contagion.

**Source of truth for all business/monetary design: `docs/projet.md`.**
Read it before any implementation work. If this file and `docs/projet.md` conflict, stop and ask.

## Escalation rule (read this twice)

**Interact with the user in French** (explanations, questions, phase notes summaries in chat).
Code, identifiers, comments, commit messages and this file stay in English.

If implementing something would require **deviating from an INVARIANT or a LOCKED decision
below, STOP and ask the user**. Do not silently pick a "reasonable default" — several
reasonable defaults are deliberately wrong in this project (see Known Traps).
Everything not locked is yours to decide; prefer simple over clever.

---

## Tech stack (LOCKED)

- **Contracts**: Solidity ^0.8.24, Foundry, OpenZeppelin v5 (AccessControl, Pausable, EIP712, Nonces, ECDSA). No upgradeability proxies — we redeploy instead.
- **Relayer/backend**: Node.js + TypeScript + viem. Single business endpoint `POST /intent`. **No database** — chain is the source of truth; backend must be stateless and rebuildable from chain reads at boot.
- **Frontend**: React + wagmi/viem. Role-based views resolved from connected address via `directory.ts` (generated at deploy) + on-chain roles.
- **Chains**: Anvil for daily dev, Sepolia for the live demo. All deploy/seed via `forge script`, addresses written to `deployments/<chain>.json` (committed).
- **Orchestration**: Docker Compose (relayer + front) + Makefile: `anvil`, `deploy-local`, `deploy-sepolia`, `seed`, `up`, `down`, `fund-check`, `test`.

## Repo layout

```
contracts/        # Foundry project (src/, test/, script/)
relayer/          # Node.js relayer
frontend/         # React app
deployments/      # <chain>.json — addresses, START_BLOCK (committed)
docs/             # projet.md (business source of truth) + monetary-design.md, architecture.md, scenarios.md, threat-model.md (French)
Makefile, docker-compose.yml, .env.example
```

---

## INVARIANTS (non-negotiable; must hold in Foundry invariant tests)

1. `wCBDC.totalSupply() == 1_000_000e6` — constant in V1. M0 only circulates, never created/destroyed after genesis.
2. Every **interbank** M1 transfer moves an exactly equal amount of wCBDC between the two banks, **in the same transaction**. No M1 crosses banks without M0 settlement.
3. `sEUR.totalSupply() <= DEP_A.balanceOf(stableCo)` at all times (100% coverage).
4. Only allowlisted addresses (the two CommercialBank contracts) ever hold wCBDC.
5. Only registered clients of a bank (plus the bank/engine mechanics) ever hold its DepositToken.
6. No intent or authorization can be replayed (sequential nonces in engine, random nonces in sEUR EIP-3009); deadlines/validity windows enforced.
7. Payments conserve aggregate value: burn(DEP_from) == wCBDC moved == mint(DEP_to).

Write a dedicated `Invariants.t.sol` using Foundry invariant testing with handler contracts.
A phase is not done if any invariant test fails.

---

## LOCKED architecture decisions

### Actors & accounts
- Guiding principle: **EOA decides, contract enforces, token accounts.** All rule-bound funds live in contracts, never on EOAs.
- 8 actor EOAs: deployer/centralBankOperator, bankAOperator, bankBOperator, stableCoOperator, alice1, alice2, bob1, bob2 — plus a dedicated relayer EOA (infra, not an actor).
- **No HD mnemonic (decided 2026-06-13).** The `.env` holds an individual private key per *server-signing* role (`*_PK`: central bank/deployer, bank A/B operators, relayer) and **addresses only** for everyone else (`*_ADDRESS`: stableCo operator, clients). The relayer holds only its own gas-only key and so cannot derive or impersonate clients — the "EOA decides" boundary is cryptographic, not conventional. Clients' keys live in MetaMask (frontend) / the smoke test alone. Scripts read `vm.envUint`/`vm.envAddress`; on Sepolia prefer an encrypted Foundry keystore for the operator keys. `make anvil` uses Anvil's default mnemonic whose well-known accounts equal those public `.env` keys.
- Clients are bare EOAs (no contracts). `StableCo` **contract** is registered as a client of Bank A.

### Contracts (7 source files, 9 deployed instances)
1. `WCBDC.sol` — restricted ERC-20: transfers only between allowlisted holders; mint/burn only by CentralBank; `SETTLER_ROLE` lets the engine move balances between banks.
2. `CentralBank.sol` — owns wCBDC admin, bank allowlist, regulatory ratio parameter (`10%`).
3. `CommercialBank.sol` (×2: A, B) — holds the bank's wCBDC reserves (reserves == `wCBDC.balanceOf(address(this))`), client registry `isClient(address)`, `freeze()/unfreeze()` (pauses its DepositToken), owns its DepositToken.
4. `DepositToken.sol` (×2: DEP-A, DEP-B) — dumb ERC-20 + `_update` hook: a transfer is valid only if (`from` AND `to` are registered clients of the owning bank) OR caller is the SettlementEngine (mint/burn paths). Pausable via its bank.
5. `SettlementEngine.sol` — verifies EIP-712 `PaymentIntent{from, fromBank, toBank, to, amount, nonce, deadline}` (ECDSA sig, **sequential per-user nonce**, deadline, both parties registered, sufficient wCBDC for interbank); executes settlement atomically; if `fromBank == toBank` → simple DEP transfer (no wCBDC).
6. `StableCo.sol` — reserve vault. Mint/redeem sEUR 1:1 against DEP. **No admin mint exists** (see traps). Composes with the engine for cross-bank cases. Operator can only `pause()`.
7. `StableEUR.sol` — permissionless ERC-20 + **EIP-3009** `transferWithAuthorization` (random 32-byte nonces, `validAfter`/`validBefore`).

### Transaction routing rule (one line)
**Client-initiated monetary flow → EIP-712 intent via relayer (gasless). Institutional/admin action → direct operator tx.** sEUR P2P additionally supports plain `transfer()` (user pays own gas) — both paths must exist.

### Constants
- All tokens: **6 decimals**.
- Genesis: wCBDC 500_000 per bank (1_000_000 total). DEP per bank: 2_400_000 / 1_600_000 to its two clients (4_000_000 total per bank). Initial ratio 12.5%, regulatory threshold 10%. StableCo starts at zero. Relayer funded with sETH + `fund-check` alert; operators ~0.05; clients ~0.02 (for direct sEUR transfers only).
- Bank balance-sheet line "loans = 3_500_000" is a **documented genesis convention**, not a token (assets = 500_000 wCBDC + 3_500_000 loans = 4_000_000 = deposits).

### Hard vs soft constraint (deliberate design)
- **Hard (physical)**: settlement reverts iff the paying bank's wCBDC balance is insufficient.
- **Soft (regulatory)**: ratio below threshold does **NOT** block payments — emit `ReserveRatioBreached(bank, ratio)` and keep settling. Bank health states: HEALTHY (ratio ≥ threshold) / STRESSED (below threshold, still paying) / ILLIQUID (cannot cover next payment → revert).

### Events rule
**Every monetary movement emits a rich event** (`Settled`, `IntrabankTransfer`, `StableMinted`,
`StableRedeemed`, `ReserveRatioBreached`, `BankFrozen`, `BankUnfrozen`, `ClientRegistered`, ...).
The frontend and all metrics are built purely from events + view calls. No event, no feature.

---

## KNOWN TRAPS — reasonable defaults that are WRONG here

1. **Cross-bank sEUR mint/redeem.** StableCo holds only DEP-A. When a Bank B client mints or redeems, a naive DEP transfer **reverts** (registry restriction). The flow MUST compose an interbank settlement in the same tx: e.g. redeem by bob1 = burn sEUR → burn StableCo's DEP-A → wCBDC A→B → mint DEP-B to bob1. This is the richest integration test of the project — write it explicitly.
2. **No admin mint on sEUR.** Supply is endogenous: minted only upon reserve receipt, to the buyer, atomically. Do not add a `MINTER_ROLE` for the operator EOA. (Circle needs one because its reserves are off-chain; ours are on-chain, so issuance is fully programmatic.)
3. **Two nonce systems coexist.** Engine intents: sequential per-user (OZ `Nonces`). sEUR EIP-3009: random 32-byte nonces with a used-nonce mapping. Do NOT unify them — 3009 compliance requires random nonces.
4. **Do not block payments on ratio breach.** Only insufficient wCBDC balance blocks. See hard/soft above.
5. **Relayer EOA nonce resync.** On boot, the relayer must read its own pending nonce from the RPC (in-flight txs may exist from before a shutdown). Also keep an in-memory idempotency cache of seen intents (loss on restart is acceptable).
6. **Don't scan Sepolia from block 0.** All event reads start at `START_BLOCK` from `deployments/<chain>.json`.
7. **Frontend gating is UX, not security.** Admin panels render based on connected address/roles, but every privileged call is enforced by `onlyRole` on-chain. Never put authorization logic only in the front or the relayer (the relayer's checks exist solely to avoid wasting gas on doomed txs).
8. **No localStorage/sessionStorage anywhere in the front.** Wallet + chain reads + React state only.

## Solidity conventions

- OpenZeppelin v5 imports; AccessControl roles named `*_ROLE`; custom errors (no revert strings); NatSpec on all external functions; checks-effects-interactions; explicit `uint256`; events past-tense.
- Tests: `forge test` green + `forge fmt` clean before any phase is declared done. Unit tests per contract (`test/unit/`), integration flows (`test/integration/`), invariants (`test/invariant/`). Name tests `test_RevertWhen_...` / `test_...` per Foundry conventions.
- Gas golf is NOT a goal; clarity is. Flag (in comments) any security-relevant choice.

---

## Implementation phases (work in this order; one phase per session/PR)

Each phase's Definition of Done: code + tests green (`make test`) + invariant suite green +
short note appended to `docs/architecture.md` describing what was built and any free choices made.

- **Phase 1 — M0**: `WCBDC`, `CentralBank`, allowlist, genesis script skeleton. Unit tests incl. transfer restrictions.
- **Phase 2 — M1 + settlement**: `CommercialBank` ×2, `DepositToken` ×2 (registry + `_update` hook + Pausable), `SettlementEngine` with direct (non-intent) settle path first. Integration tests: intrabank, interbank, illiquidity revert, ratio-breach event, freeze. Invariant suite bootstrapped here.
- **Phase 3 — Intents + relayer**: EIP-712 `PaymentIntent` verification in engine; relayer service (`POST /intent`, sig pre-check, idempotency cache, boot resync, fund-check); Makefile + Docker Compose + Anvil/Sepolia profiles; full genesis seed.
- **Phase 4 — Stablecoin**: `StableCo`, `StableEUR` + EIP-3009; same-bank and **cross-bank** mint/redeem (trap #1); both P2P transfer paths. Coverage invariant (#3) added to suite.
- **Phase 5 — Frontend**: role-resolved views (client / bank operator / StableCo / central bank / observer) per `docs/projet.md` §7; event-driven metrics; payment form with EIP-712 signing and status tracking; balance-sheet view with ratio gauge and health states.
- **Phase 6 — Docs & polish**: French docs (`monetary-design.md`, `architecture.md` final pass, `scenarios.md`, `threat-model.md`), README quickstart, `forge verify-contract` on Sepolia.

V2+ (scenario agents, interbank market, refinancing/LOLR, SIWE-protected scenario endpoints,
AMM, multi-chain) is OUT OF SCOPE for now — do not scaffold for it beyond what's free.

## Degrees of freedom (decide without asking)

Internal function decomposition and storage layout; test organization beyond required coverage;
relayer framework choice (Express/Fastify/Hono) and project structure; React component structure,
styling, state management; error message wording; extra event parameters; script structure.
Record notable free choices in the phase note.

## Commands

```bash
make anvil            # local chain
make deploy-local     # deploy + seed on Anvil
make deploy-sepolia   # one-shot testnet deploy (writes deployments/sepolia.json)
make seed             # genesis seeding
make test             # forge test (unit + integration + invariants)
make up / make down   # docker compose (relayer + front), CHAIN=local|sepolia
make fund-check       # relayer sETH balance alert
```

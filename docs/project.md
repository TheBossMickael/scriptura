# Two-Tier Money — project blueprint

> The consolidated design document: vision, actors, mechanisms, genesis, infrastructure
> decisions and roadmap. It reflects the system **as built** (V1, live on Sepolia).
> Deep dives: [monetary-design.md](monetary-design.md) (the why),
> [architecture.md](architecture.md) (the how), [contracts.md](contracts.md),
> [scenarios.md](scenarios.md), [threat-model.md](threat-model.md),
> [frontend.md](frontend.md), [indexer.md](indexer.md).

---

## 1. Vision

A complete **on-chain simulation of the two-tier monetary system**, deployed and verified
on Sepolia: tokenized central bank money (wCBDC), tokenized commercial bank deposits
(DEP-A/DEP-B), and a fiat-backed stablecoin (sEUR) whose reserves are tokenized deposits —
with atomic interbank settlement, health monitoring, and a role-based frontend.

What it demonstrates:

- **The singleness of money**: a euro at Bank A equals a euro at Bank B *because* every
  interbank transfer of commercial money settles in central bank money, atomically.
- **Structural bank fragility**: fractional reserves make runs possible; health states
  (HEALTHY / STRESSED / ILLIQUID) make stress observable and gradual.
- **TradFi → stablecoin contagion**: sEUR's reserves are bank deposits; trouble at the
  bank is trouble for the coin.
- **Intermediated vs permissionless money**: DEP depends on its bank and relayer; sEUR
  keeps circulating when both are down.
- **The transparency paradox**: everything is public on-chain — which builds trust *and*
  lets panics coordinate faster.

## 2. Actors

**Guiding principle: the EOA decides, the contract enforces, the token accounts.** All
rule-bound funds live in contracts, never on operator EOAs.

| Actor | EOA | Contract | The contract's job |
|---|---|---|---|
| Central bank | operator (= deployer) | `CentralBank` | M0 issuance, bank allowlist, ratio parameter |
| Bank A / Bank B | one operator each | `CommercialBank` ×2 | Reserves, client registry, freeze, owns its DepositToken |
| StableCo | operator | `StableCo` | Reserve vault, 1:1 mint/redeem, on-chain proof of reserves |
| Clients | alice1/2 (Bank A), bob1/2 (Bank B) | none — bare EOAs | Clients carry no rules; they only sign (EIP-712 intents, EIP-3009 authorizations) |

Plus a dedicated **relayer** EOA (infrastructure, not an actor). **No HD mnemonic**: the
`.env` holds an individual private key per server-signing role and *addresses only* for
clients — the relayer cannot derive or impersonate anyone
([architecture.md §7](architecture.md)). The `StableCo` contract itself is registered as
a client of Bank A (a contract can be a client).

## 3. Tokens

| Token | Layer | Issuer | Holders | Decimals |
|---|---|---|---|---|
| wCBDC | M0 | CentralBank | Allowlisted banks only | 6 |
| DEP-A / DEP-B | M1 | Each CommercialBank | Registered clients of that bank | 6 |
| sEUR | private | StableCo | Anyone (permissionless) | 6 |

## 4. Key mechanisms

- **Atomic interbank settlement** — the core: burn payer's DEP → move wCBDC between bank
  reserves → mint payee's DEP, in one transaction. Intrabank payments are pure book
  transfers (no wCBDC). Walk-through with numbers: [scenarios.md](scenarios.md) S1–S2.
- **Routing rule (one line)**: client-initiated monetary flow → EIP-712 intent via the
  relayer (gasless); institutional/admin action → direct operator transaction. sEUR P2P
  additionally supports a plain `transfer()` (holder pays gas) — both paths exist on
  purpose.
- **Stablecoin issuance is endogenous**: minted only against reserves received, atomically,
  to the buyer; redeemed symmetrically; **no admin mint exists**. Cross-bank mint/redeem
  composes an interbank settlement in the same transaction — the richest flow in the
  system ([scenarios.md](scenarios.md) S7–S8). The StableCo operator can only pause.
- **Hard vs soft constraint**: only insufficient wCBDC blocks a payment (revert). A ratio
  below threshold emits `ReserveRatioBreached` and settlement continues — monitored, not
  enforced per transaction.
- **Health states**: 🟢 HEALTHY (ratio ≥ 10%) · 🟠 STRESSED (below, still paying) ·
  🔴 ILLIQUID (cannot cover the next payment → revert; illiquid ≠ insolvent).
- **Freeze/unfreeze**: pauses a bank's DepositToken entirely (settlements included, both
  directions) — realism (suspended banks), the future depeg trigger, and the
  DEP-vs-sEUR contrast in one switch.
- **Events rule**: every monetary movement emits a rich event (`Settled`,
  `IntrabankTransfer`, `StableMinted`, `StableRedeemed`, `ReserveRatioBreached`,
  `BankFrozen`, `ClientRegistered`, …). The frontend and all metrics are built purely from
  events + view calls. No event, no feature.

## 5. Use cases (V1)

| # | Use case | Initiator | Path |
|---|---|---|---|
| 1 | Intrabank payment | Client | Intent → relayer → engine (book transfer) |
| 2 | Interbank payment | Client | Intent → relayer → engine (atomic settlement) |
| 3 | Mint sEUR (Bank A client) | Client | Intent → relayer → StableCo (book transfer + issue) |
| 4 | Mint sEUR (Bank B client) | Client | Intent → StableCo ∘ engine (composed settlement) |
| 5 | Redeem sEUR (both cases) | Client | Mirror of 3/4 |
| 6 | sEUR P2P | Client | EIP-3009 gasless via relayer, or direct `transfer()` |
| 7 | Public onboarding (Option B) | Visitor | `POST /faucet` → relayer's `FAUCET_ROLE` → `onboard()` (register + capped credit, one-shot) |
| 8 | Admin: clients, freeze, allowlist, threshold | Operators | Direct transactions |

## 6. Genesis (V1)

| Item | Value |
|---|---|
| wCBDC total (M0) | **1,000,000** — constant in V1 (invariant 1) |
| Reserves per bank | 500,000 / 500,000 |
| Deposits per bank | 4,000,000 — split 2,400,000 / 1,600,000 across its two clients |
| Initial ratio / threshold | 12.5% / 10% |
| "Loans" balance-sheet line | 3,500,000 per bank — documented convention, not a token |
| StableCo | Starts at zero (the first mint happens live) |
| sETH | Relayer funded + balance alert; operators ~0.05; clients ~0.02 (direct sEUR path only) |

The deploy script produces this state reproducibly and idempotently
(`make deploy-local` / `make deploy-sepolia`, then `make seed` to re-seed).

## 7. Invariants

Tested with Foundry invariant testing (handler-driven fuzzing, zero tolerated reverts):

1. `wCBDC.totalSupply()` constant at 1,000,000 (V1).
2. Interbank M1 transfers move an exactly equal amount of wCBDC, in the same transaction.
3. `sEUR.totalSupply() ≤ DEP-A.balanceOf(StableCo)` — 100% coverage, always.
4. Only allowlisted banks hold wCBDC.
5. Only registered clients hold a bank's deposits.
6. No intent or authorization replay (three separate nonce namespaces + deadlines).
7. Payments conserve aggregate value.

Full mapping to code and tests: [contracts.md](contracts.md).

## 8. Stack and infrastructure decisions

| Domain | Choice | Why |
|---|---|---|
| Contracts | Solidity ^0.8.24, **Foundry**, OpenZeppelin v5 | Professional standard; native invariant testing |
| Chains | **Anvil** (daily dev) + **Sepolia** (live demo, Etherscan-verified) | Instant local loop; durable public artifact |
| Relayer | **Node 20 + TypeScript + Fastify + viem**; `POST /intent` + `POST /faucet` | The EIP-712 signature *is* the authentication — no sessions, no users table |
| Frontend | **React + wagmi/viem**, addresses from committed `deployments/<chain>.json` | Role-resolved views, direct chain reads |
| Indexer | **Ponder** + custom REST API | History without rescanning; a derived, rebuildable store |
| Persistence | **None.** Chain = source of truth; relayer stateless | Everything re-derivable from chain + config |
| Auth | The wallet. SIWE deliberately deferred to V2 (scenario-control endpoints) | V1's single business endpoint is self-authenticating |
| Orchestration | **Makefile host targets** — three terminals (`make relayer`, `make indexer`, `make front`) | Docker was dropped (2026-06-29): unvalidated images and broken local tooling beat no value into the demo |
| Verification | Inline `--verify` during `make deploy-sepolia` | All 9 instances readable on Etherscan during demos |

**Lifecycle / restarts.** Everything vital is on-chain (balances, registries, nonces,
history). The repo persists `deployments/<chain>.json` and `.env.example`; the gitignored
`.env` persists keys. At boot the relayer re-reads on-chain nonces and resyncs its own
pending transaction count; its idempotency cache is disposable. Redeploying (for V2) means
a new deployments file + re-seed — non-destructive, and a reproducibility test of the
genesis.

**Assumed operational risk.** The relayer is a single point of failure — accepted in V1,
documented in [threat-model.md](threat-model.md) (with the TARGET2-outage parallel), and
exploited as a V2 scenario (censorship/outage: DEP payments stall, sEUR keeps moving).

## 9. Roadmap

**V1 — the core (done, live on Sepolia).** 3 token types, 7 contracts, atomic settlement,
EIP-712 + EIP-3009 gasless flows, stateless relayer, public onboarding, 5-view frontend,
indexer, 155 Foundry tests + invariant suite, full E2E validated on the live deployment.

**V2 — crisis and liquidity.** Orchestrated scenarios via off-chain agents: bank run
(agents follow "if my bank's ratio < X%, flee" → cascade), depeg (freeze Bank A → redeems
revert → coverage breaks), relayer censorship/outage (DEP dead, sEUR alive). Interbank
lending market. Refinancing against collateral (`BondToken`, haircut, rate) and **lender
of last resort** (larger haircut, penalty rate — Bagehot). SIWE (EIP-4361) to protect the
scenario-control endpoints. Dynamic M0 → invariant 1 refined to `ΔM0 == net refinancing`.

**V3 — markets and policy.** An sEUR/DEP AMM so a *market price* exists → observable
depeg. Remunerated reserves (interest-rate policy). Credit creation ("loans make
deposits") turning the genesis loans line into real dynamics.

**V4 — multi-chain.** The natural continuation: the L1 as the central bank / settlement
layer, one rollup per commercial bank, cross-chain settlement via HTLCs and intents —
the unified-ledger idea stretched across chains.

## 10. Deliverables

- Contracts + tests (`contracts/`), relayer (`relayer/`), frontend (`frontend/`),
  indexer (`indexer/`) — all live on Sepolia, addresses in
  [`deployments/sepolia.json`](../deployments/sepolia.json).
- Documentation: this file plus the seven focused docs linked at the top.
- [README](../README.md): pitch, quickstart, verified contracts and reference
  transactions.

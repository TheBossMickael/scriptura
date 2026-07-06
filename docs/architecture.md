# Architecture

> How Two-Tier Money is built: the on-chain contracts, the three off-chain services, the
> flows that tie them together, and the operational choices (keys, chains, RPC). For the
> monetary rationale see [monetary-design.md](monetary-design.md); for per-contract
> reference see [contracts.md](contracts.md); deep dives:
> [frontend.md](frontend.md), [indexer.md](indexer.md), [threat-model.md](threat-model.md).

---

## 1. System overview

```
              MetaMask (client keys: EIP-712/3009 signing · operator direct txs)
                                       │
                       ┌───────────────┴────────────────┐
                       │  Frontend — Vite + React/wagmi │  :5173
                       │  5 role views · read-only mode │
                       └──┬────────────┬────────────┬───┘
             POST /intent │            │ GET /…     │ live reads (viem)
             POST /faucet │            │            │
                ┌─────────▼──────┐  ┌──▼──────────┐ │
                │ Relayer        │  │ Indexer     │ │
                │ Fastify + viem │  │ Ponder+Hono │ │
                │ :3001 stateless│  │ :42069      │ │
                └─────────┬──────┘  └──▲──────────┘ │
                    txs   │            │ eth_getLogs│
                          ▼            │            ▼
       ┌───────────────────────────────┴──────────────────────────┐
       │        Chain (Anvil dev / Sepolia live) — source of truth │
       │   CentralBank──wCBDC    Bank A──DEP-A    Bank B──DEP-B    │
       │   SettlementEngine      StableCo──sEUR                    │
       └───────────────────────────────────────────────────────────┘
```

Three long-running services (three terminals: `make relayer / indexer / front`)
around one chain. **There is no database anywhere**: the relayer is stateless and re-derives
everything at boot from the chain and `deployments/<chain>.json`; the indexer's store is a
*derived, rebuildable* projection of event logs; the frontend keeps state in the wallet,
chain reads and React state only (no localStorage).

## 2. On-chain layer

### 2.1 Contracts — 7 source files, 9 deployed instances

| Contract | Instances | Responsibility |
|---|---|---|
| `CentralBank` | 1 | Owns all wCBDC admin: bank allowlist, M0 issuance (genesis only in V1), regulatory ratio threshold (10%), engine wiring |
| `WCBDC` | 1 | Restricted ERC-20 (M0): only allowlisted banks hold it; `settle()` moves reserves without allowance (engine's `SETTLER_ROLE`) |
| `CommercialBank` | 2 (A, B) | Holds wCBDC reserves (`reserves() == wcbdc.balanceOf(this)`), client registry, `freeze()/unfreeze()`, faucet onboarding, owns its DepositToken |
| `DepositToken` | 2 (DEP-A, DEP-B) | Restricted ERC-20 (M1): `_update` hook requires registered clients at both ends; Pausable by its bank |
| `SettlementEngine` | 1 | The core: verifies EIP-712 `PaymentIntent`s and executes intrabank book transfers or atomic interbank settlement; restricted composition entry points for StableCo |
| `StableCo` | 1 | Reserve vault: verifies `MintIntent`/`RedeemIntent`, composes settlement + sEUR mint/burn atomically; client of Bank A; operator can only pause |
| `StableEUR` | 1 | Permissionless ERC-20 (sEUR) + full EIP-3009 (`transferWithAuthorization` / `receiveWithAuthorization` / `cancelAuthorization`) |

All tokens use 6 decimals. Contract addresses are never hardcoded: everything reads
`deployments/<chain>.json`, written by the deploy script.

### 2.2 Atomic wiring pattern

Every institution deploys its own token **in its constructor**: `CentralBank` deploys
wCBDC, each `CommercialBank` deploys its DepositToken, `StableCo` deploys sEUR. The token
is born with its institution as sole admin — there is no configuration window in which a
third party could hold (or grab) token powers. Engine privileges are granted afterwards by
each institution's operator (`setSettlementEngine`, `setStableCo`), and are **re-settable**
(grant to the new engine, revoke from the previous one) so a redeployed component can be
re-pointed without redeploying the rest.

### 2.3 Role matrix

| Holder | Role | On | Grants the power to |
|---|---|---|---|
| CentralBank (contract) | `DEFAULT_ADMIN` + `MINTER/BURNER` | wCBDC | Allowlist banks, issue/destroy M0 |
| SettlementEngine | `SETTLER_ROLE` | wCBDC | Move reserves between banks (no allowance) |
| SettlementEngine | `MINTER/BURNER/SETTLER_ROLE` | DEP-A, DEP-B | Execute the settlement legs |
| Each CommercialBank (contract) | `DEFAULT_ADMIN` + `MINTER` + `PAUSER` | its DepositToken | Genesis credit, freeze/unfreeze |
| StableCo (contract) | `DEFAULT_ADMIN` + `MINTER/BURNER` | sEUR | Endogenous issuance — **no EOA can ever mint sEUR** |
| Operator EOAs | `OPERATOR_ROLE` | their institution | Institutional actions (register clients, freeze, thresholds, pause) |
| Relayer EOA | `FAUCET_ROLE` | both banks | `onboard()` only: register + credit ≤ `MAX_FAUCET_CREDIT`, one-shot per address — never freeze or rewire |

Note the shape: **contracts hold the token powers, EOAs hold powers over contracts.**
"The EOA decides, the contract enforces, the token accounts."

### 2.4 Transaction routing rule

> **Client-initiated monetary flow → signed EIP-712 intent, relayed gasless.
> Institutional/admin action → direct transaction from the operator's wallet.**

Client payments enter the engine *exclusively* via `executeIntent` (the Phase 2 direct
path was removed). The engine is **relay-agnostic**: anyone holding a valid signature may
submit it, so relayer censorship is operational, never contractual — a client can always
self-relay by paying their own gas. The single exception is sEUR P2P, which deliberately
supports both a gasless EIP-3009 path and a plain `transfer()` (holder pays gas).

### 2.5 Three nonce namespaces (never unified)

| Namespace | Contract | Scheme | Protects |
|---|---|---|---|
| Payment intents | SettlementEngine | Sequential per payer (OZ `Nonces`) | `executeIntent` replay/ordering |
| Mint/redeem intents | StableCo | Sequential per client (own counter) | `mintFromIntent` / `redeemFromIntent` |
| sEUR authorizations | StableEUR | Random 32-byte + used-nonce map | EIP-3009 transfers (spec-required randomness) |

Sequential nonces impose "one in-flight action per client" (the UI enforces this);
EIP-3009 requires random nonces for standard compliance. Keeping them separate is a
deliberate, documented decision.

## 3. Key flows

### 3.1 Interbank payment (the core flow)

1. **Sign** — the frontend reads `engine.nonces(payer)` fresh, builds
   `PaymentIntent{from, fromBank, toBank, to, amount, nonce, deadline = now+1h}` and has
   MetaMask sign the EIP-712 digest (domain `SettlementEngine/1`).
2. **Relay** — `POST /intent {type: "payment", intent, signature}`. The relayer runs its
   pre-check pipeline (§4) and submits `executeIntent` from its own gas-paying EOA,
   answering `{digest, txHash, status: "submitted"}`.
3. **Execute (one transaction)** — the engine checks deadline → recovers the signer →
   consumes the sequential nonce → `_settle`: both banks registered, both parties clients;
   same bank ⇒ book transfer (`IntrabankTransfer`); different banks ⇒ explicit
   `InsufficientReserves` pre-check (the ILLIQUID state), then **burn DEP(payer) → move
   wCBDC(bank→bank) → mint DEP(payee)**, `Settled`, and the paying bank's permissionless
   `checkReserveRatio()` (may emit `ReserveRatioBreached` — soft, never blocking).
4. **Confirm** — the frontend awaits the receipt (checking `status`, 120 s timeout), shows
   the hash/Etherscan link in-section, and invalidates every read. The indexer picks the
   events up within its polling window.

### 3.2 Cross-bank sEUR mint/redeem (the composed flow)

A Bank B client minting sEUR cannot simply send DEP-B to StableCo (registries forbid
cross-bank holding). Instead, one transaction composes all three monetary layers:

```
StableCo.mintFromIntent(intent, sig)          [verifies sig + own sequential nonce]
  └─ engine.settleToStable(bob, bankB, amt)   [restricted: msg.sender == stableCo]
       └─ _settle(bob, B → A, stableCo, amt)  [burn DEP-B → wCBDC B→A → mint DEP-A]
  └─ seur.mint(bob, amt)                      [reserves arrived first: coverage-safe]
```

Redeem is symmetric with the opposite ordering (burn sEUR **before** reserves leave, via
`settleFromStable`). The engine forces the StableCo side of the settlement itself
(payee/payer = StableCo, bank = the cached `stableCoBank`) so the vault can never be
tricked with a forged bank argument, and these entry points consume **no engine nonce** —
replay protection lives in StableCo's own counter. When the client banks at Bank A, the
identical call collapses to an intrabank book transfer: StableCo contains no
same-bank/cross-bank branching at all.

### 3.3 Public onboarding — Option B

A connected wallet unknown to the system can act, not just observe: the frontend's
**Join** modal calls `POST /faucet {address, bank}` (no client signature — the relayer's
`FAUCET_ROLE` is the authority). The relayer simulates then submits
`CommercialBank.onboard(visitor, FAUCET_AMOUNT)`, which registers **and** credits in one
call, capped on-chain (`MAX_FAUCET_CREDIT`) and one-shot per address (second attempt
reverts `AlreadyClient` → HTTP 409). The visitor then pays, mints and redeems with their
own signatures — entirely gasless; sETH is only needed for the *direct* sEUR transfer path.

### 3.4 sEUR peer-to-peer — two paths

- **Gasless**: the holder signs an EIP-3009 `TransferWithAuthorization` (random nonce,
  `validBefore = now+1h`); the relayer checks the validity window and
  `authorizationState`, then submits. No sETH needed.
- **Direct**: the holder calls `transfer()` from their own wallet (pre-simulated by the
  UI to surface any revert before the wallet popup). Requires sETH.

Same money, two trust models — the disintermediation contrast is the point.

## 4. The relayer

Node 20 + TypeScript + Fastify + zod + viem. **Stateless by design**: no database, an
in-memory idempotency cache that is disposable (after a restart, a replayed intent simply
falls through to the on-chain nonce check). It holds exactly **one private key** — its own
gas-paying EOA (plus the narrow on-chain `FAUCET_ROLE`); it cannot derive or impersonate
any client.

**Boot sequence** (everything re-derived): load `deployments/<chain>.json` → assert the
RPC's chainId matches → assert `RELAYER_PK` derives the deployed relayer address → resync
the EOA nonce from the RPC's **pending** count (in-flight transactions from before a
restart must not be double-spent) → initial fund check, then a periodic balance watcher
(`MIN_RELAYER_BALANCE` alert, also exposed by `make fund-check`).

**Endpoints**: `POST /intent` — a discriminated union (`payment` | `mint` | `redeem` |
`transfer3009`) so one business endpoint absorbs every client-signed message; `POST
/faucet` (Option B); `GET /health` (chain, addresses, balance, cache size, faucet amount).

**Pre-check pipeline** (sequentially-nonced intents): idempotency cache (same digest →
same original response, upgraded by a fire-and-forget receipt watcher; `failed` entries
are evicted so a retry is allowed) → local EIP-712 signature verification → wall-clock
deadline → exact on-chain nonce equality (mismatch → `409 nonce_mismatch`) →
`simulateContract`, decoding custom errors into structured 400/409 responses → **serialized
send queue** (one transaction in flight at a time, so intents never race for the relayer's
own nonce). Every pre-check exists only to avoid wasting gas on doomed transactions —
authorization is enforced on-chain, nowhere else.

## 5. The indexer

Ponder + a custom REST API (Hono) on :42069. It watches the five event-emitting contracts
(engine, both banks, StableCo, sEUR) from the deploy block (`startBlock` — never block 0)
and projects the rich events into 8 derived tables (payments, stable flows, ratio
breaches, freeze history, client registry/events, sEUR transfers and running holder
balances). The REST layer returns predictable JSON with bigints as decimal strings.

This does **not** violate the no-database rule: the store is a read-side cache, fully
rebuildable from logs — it is never pushed, never backed up, and deleting it loses
nothing. On Sepolia the indexer uses its own getLogs-friendly RPC failover pool with wide
fixed ranges and 15 s polling; history consequently lags the head by ~30 s–2 min, while
live balances (direct RPC reads in the frontend) stay instant. Full rationale and the
hard-won RPC lessons: [indexer.md](indexer.md).

## 6. The frontend

Vite + React + wagmi v2/viem. The connected address is resolved to a role **on-chain**
(`hasRole` / `isClient` — never from a local mapping) and rendered as one of five views:
client, bank operator (A/B), StableCo, central bank, observer; a view switcher lets anyone
open any dashboard **read-only** (data is public; actions stay gated on-chain — the UI
gating is UX, not security). Key mechanics:

- **Blocking UX**: a global pending lock disables every action button while a transaction
  is in flight (no bursts — sequential nonces make them pointless anyway); per-action
  progress, hash and Etherscan link render in-section (`TxStatus`).
- **Pre-simulation** of every direct write, so the exact custom error surfaces *before*
  the wallet popup; receipts are checked for `status: reverted` (a mined revert does not
  throw) with a 120 s timeout.
- **Chain pinning**: `VITE_CHAIN` selects which committed deployment the app targets;
  reads are pinned to that chain (`syncConnectedChain: false`) regardless of the wallet's
  network, and writes assert an explicit `chainId` (loud failure + a switch-network banner
  instead of silently targeting the wrong chain).
- **Freshness**: event watchers on the five contracts invalidate all reads on any new
  event; a slow 15 s poll is only the safety net; every confirmed action invalidates
  everything.

Details and UX decisions: [frontend.md](frontend.md).

## 7. Keys and accounts — no mnemonic, by design

There is deliberately **no HD mnemonic** anywhere: a single seed would be the maximal
root secret *and* would let the backend derive the clients' keys — i.e. impersonate them,
breaking "the EOA decides" at its root. Instead:

| Account | Custody | In `.env` |
|---|---|---|
| Central bank operator (deployer), Bank A/B operators, StableCo operator | Sign deploys/institutional txs | Individual `*_PK` (server-signing roles) |
| Relayer | Long-running service; gas + `FAUCET_ROLE` only | `RELAYER_PK` (its single key) |
| Clients (alice1/2, bob1/2, visitors) | MetaMask only — never the backend | `*_ADDRESS` only |

The boundary is cryptographic, not conventional: the relayer *cannot* forge a client
signature. Locally, `make anvil` uses Anvil's default accounts, whose well-known public
keys are exactly what `.env.example` ships. On Sepolia the operator keys are throwaway
testnet keys in the gitignored `.env` (an encrypted Foundry keystore was considered and
documented as the production posture; the deploy broadcasts as four distinct operators,
which a single `--account` keystore does not cover). The only client key that ever
appears is `ALICE1_PK`, used by the local smoke script alone.

## 8. Deployment and environments

**Anvil for daily dev, Sepolia for the live demo.** One `make deploy-sepolia` performs the
full genesis — deploy, wire, allowlist, mint M0, register/credit clients, grant
`FAUCET_ROLE`, fund actors with sETH (top-up semantics, idempotent) — and verifies all 9
instances on Etherscan inline (`--verify`, constructor args resolved from the broadcast,
nested deployments included). It writes `deployments/<chain>.json` — addresses of the 9
contracts, the 8 actors and the relayer, `chainId`, `startBlock` — which is **committed**
and becomes the single wiring source for relayer, indexer and frontend. `make seed`
replays the genesis idempotently (useful to top up drained gas balances without
redeploying). The live deployment: chainId 11155111, startBlock 11180344, deployed and
verified 2026-07-01.

**RPC allocation on Sepolia** (one endpoint per workload — the lesson of trap #9):

| Consumer | Endpoint | Why |
|---|---|---|
| Relayer + deploys | `SEPOLIA_RPC_URL` (e.g. Alchemy) | Low volume, no `eth_getLogs` |
| Indexer | `PONDER_RPC_URL` failover pool (drpc, tenderly) | Backfill needs wide `eth_getLogs` ranges — Alchemy Free hard-caps them at 10 blocks |
| Frontend | viem's default public RPC (batched), optional `VITE_SEPOLIA_RPC_URL` | Browser-side; a key here would ship in the JS bundle |

## 9. Build history (condensed)

The project was built in strict phases, each gated on green tests (unit + integration +
invariants), `forge fmt`, and a written phase note. Condensed record — the full
incremental notes live in this file's git history.

| Phase | Date (2026) | Delivered |
|---|---|---|
| 1 — M0 | 06-10 | `WCBDC` + `CentralBank`, allowlist-in-token, atomic wiring pattern; genesis recalibrated (1M wCBDC, 12.5% vs 10%). 33 tests. |
| 2 — M1 + settlement | 06-12 | Banks, deposit tokens, engine with a temporary direct path; intrabank = true book transfer (`SETTLER_ROLE`, not burn+mint); permissionless `checkReserveRatio`; invariant suite bootstrapped, `fail_on_revert`. 100 tests. |
| 3 — Intents + relayer | 06-13 | EIP-712 `PaymentIntent` + sequential nonces; direct path **removed** (engine relay-agnostic); stateless relayer (pre-checks, idempotency, boot nonce resync); **no-mnemonic key model**; full genesis scripts + `deployments/<chain>.json`. 112 tests. |
| 4 — Stablecoin | 06-26 | `StableCo` + `StableEUR` (full EIP-3009); cross-bank mint/redeem composed via restricted `settleTo/FromStable`; coverage-safe ordering; coverage invariant. 151 tests. |
| 4.5 — Option B | 06-26 | `onboard()` behind a narrow `FAUCET_ROLE` granted to the relayer's own EOA; on-chain cap + one-shot per address; `POST /faucet`. 155 tests. |
| 5 — Frontend + indexer | 06-27/28 | Five role views + read-only explorer; blocking UX with in-section `TxStatus`; pre-simulated writes; event-driven refresh; Ponder indexer + custom REST API. 25+25 vitest. |
| 6a — Sepolia live | 07-01/02 | Docker dropped (Makefile host targets only); one-shot deploy + inline Etherscan verify of all 9 instances; front chain-select (`VITE_CHAIN`) + chain-pinned reads; indexer RPC failover pool. **Full E2E user simulation green on live Sepolia**: onboarding, intrabank/interbank payments, same- and cross-bank mint/redeem, gasless 3009 transfer, replay idempotence, stale-nonce 409 — all seven invariants re-verified on-chain to the cent. |
| 6b — Docs & release | 07 | English documentation set, README + screenshots, MIT license; Makefile service targets renamed (`-dev` dropped) and stale comments scrubbed — no functional changes; `v1.0.0` tag. |

Final test surface: **155 Foundry tests** (132 unit, 17 integration, 6 invariant properties
at 128 runs × depth 64 with zero tolerated reverts) + **25 relayer** and **25 frontend**
vitest suites, `tsc --noEmit` clean across all three TypeScript projects.

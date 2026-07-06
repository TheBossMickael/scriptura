# Frontend

> Vite + React + TypeScript + wagmi v2/viem. One app, five role-resolved dashboards, no
> backend of its own: the wallet is the authentication, the chain is the data source, the
> relayer is the gasless write path, the indexer serves history. State lives in the wallet,
> chain reads and React state only — **no localStorage/sessionStorage anywhere**.

## Wiring

- **Deployment selection**: `VITE_CHAIN` (`local` | `sepolia`) picks which committed
  `deployments/<chain>.json` the app targets; both files are statically imported, so the
  import always resolves. All addresses, actor labels and the expected `chainId` derive
  from that file (`src/lib/directory.ts`) — nothing is hardcoded. An incomplete file
  renders a "run `make deploy-<chain>`" screen instead of crashing. Note: Vite reads env
  at **dev-server start** — a missing/late `VITE_CHAIN` is the classic "skeletons +
  ERR_CONNECTION_REFUSED on 127.0.0.1:8545" symptom.
- **Service URLs**: relayer `:3001`, indexer `:42069` by default (`VITE_RELAYER_URL` /
  `VITE_PONDER_URL` to override). Env is read from the repo-root `.env` (`envDir`), so one
  file governs the whole stack.
- **ABIs are frontend-owned** (`src/lib/abis.ts`, minimal `parseAbi` definitions), matching
  the per-project ABI convention (a shared cross-project `abis/` folder breaks module
  resolution between separate npm projects — tried and reverted).

## Role resolution and views

The connected address is resolved **on-chain** — `hasRole(OPERATOR_ROLE)` on the four
institutions, `isClient` on both banks — never from a local mapping, so a wallet
onboarded ten seconds ago resolves correctly. Priority: central bank > bank operator >
StableCo operator > client > observer.

| View | Who | Contents |
|---|---|---|
| Observer | anyone (default) | All public metrics: M0/M1/sEUR aggregates, per-bank health cards with ratio gauges, StableCo proof of reserves, recent payments, breach wall — plus the **Join** card for a connected-but-unknown wallet |
| Client | registered clients | Balances, payment form, sEUR mint/redeem, both P2P paths, personal history, own bank's health (the panic signal) |
| Bank operator (A/B) | operator wallet | Two-column live balance sheet (reserves + genesis loans vs deposits) with ratio gauge and health badge, freeze/unfreeze, client registry management (register/credit/remove), inflows/outflows |
| StableCo | operator wallet | Proof of reserves, coverage badge, holders, mint/redeem volumes, pause/unpause |
| Central bank | operator wallet | Macro aggregates, per-bank monitors, bank allowlist, ratio-threshold form, `ReserveRatioBreached` alert wall, all interbank flows |

A **view switcher** lets anyone open any dashboard read-only (`Read-only preview` banner;
action buttons pre-simulate and would revert on-chain anyway — the gating is UX, not
security). Views are keyed by `view:account` so form state and transaction feedback never
leak across dashboards or wallet switches.

## Actions pipeline

One hook (`useTx`) drives every action through the same lifecycle:

- **Gasless (`relay`)**: read the *fresh* sequential nonce at click time → build the
  intent (1-hour deadline; random 32-byte nonce for EIP-3009) → MetaMask signs the
  EIP-712 payload (typed data mirrored byte-for-byte from the contracts) → `POST` to the
  relayer → wait for the on-chain receipt.
- **Direct (`direct`)**: **pre-simulate** the call first, so the exact custom error
  (`AlreadyClient`, `ClientHasBalance`, `InsufficientReserves`…) surfaces as a friendly
  message *before* any wallet popup; then write with an explicit `chainId` and confirm.
- **Confirmation**: receipts are checked for `status: reverted` (a mined revert resolves,
  it does not throw) with a 120 s timeout so the UI never hangs; structured relayer errors
  (`409 nonce_mismatch`, `AlreadyClient`…) map to actionable messages.

**Blocking UX**: while any action is in flight, a global pending lock disables every
action button in the app — no concurrent intents, which the sequential nonces would
reject anyway ("no bursts" as a UX guarantee). Per-action progress renders **in-section**
via `<TxStatus>`: spinner → tx hash + Etherscan link as soon as known, persisting ~30 s.
On success, every read is invalidated at once (balances, roles, metrics) — which is also
what flips a freshly onboarded observer into the client view.

## Data and freshness

Two sources, deliberately split:

- **Live state** (balances, reserves, ratios, supplies, pause flags, nonces): direct
  RPC view calls via wagmi/viem — instant and trustless.
- **History** (payments, mint/redeem flows, breaches, clients, holders): the indexer's
  REST API — may lag the head by ~30 s–2 min on Sepolia ([indexer.md](indexer.md)).

Freshness is event-driven: watchers on the five contracts invalidate all reads on any new
event (cross-actor updates appear without polling); a slow 15 s poll remains as the safety
net for a missed event.

## Chain pinning (trap #10)

Default wagmi re-routes every read to whatever network the connected wallet sits on — one
wallet on mainnet and the whole UI turns into loading skeletons. The config pins
everything instead: the deployment's chain is `chains[0]` with `syncConnectedChain:
false`, so **reads always target the deployment chain** regardless of the wallet; writes
assert an explicit `chainId` (loud mismatch failure instead of a transaction on the wrong
network) and the header offers the switch. On Sepolia the transport batches JSON-RPC calls
(the ~14-read snapshot becomes a handful of HTTP requests) and watchers poll at 12 s
(block time) instead of wagmi's 4 s default.

## Known quirks

- `parseAmount` treats commas as **en-US thousands separators**: `1,500` parses as 1500
  (not 1.5). Decimal separator is the dot.
- History sections depend on the indexer being up; live balances do not.
- The recipient picker lists the four genesis clients; self-onboarded visitors are reached
  via manual address entry.

## Tests

25 vitest tests on the pure logic (`roles` resolution, `metrics` health/coverage,
`format` parsing/formatting, `intents` payload building); `tsc --noEmit` clean. UI flows
were validated end-to-end against live Sepolia (see [scenarios.md](scenarios.md)).

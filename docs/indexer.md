# Indexer

> A Ponder indexer with a hand-rolled REST API (Hono) on `:42069`. It turns the system's
> rich events into the history tables the frontend reads — payments, stable flows,
> breaches, freezes, client registry, sEUR transfers and holders — so dashboards don't
> re-scan the chain on every load.

## Why it does not violate "no database"

The project rule is *chain = source of truth, no persistent state*. The indexer's store is
a **derived, rebuildable projection** of event logs: it is gitignored (`.ponder/`), never
backed up, and deleting it loses nothing — a fresh start re-derives everything from
`startBlock`. The relayer stays fully stateless; only this read-side cache exists, and
only for query comfort.

## Configuration

Same conventions as the relayer: `CHAIN_NAME` selects the committed
`deployments/<chain>.json`, from which addresses and `startBlock` are read (never
hardcoded, never block 0 — trap #6). Five contracts are watched from that single deploy
block: SettlementEngine, Bank A, Bank B, StableCo, sEUR.

Sepolia-specific settings (each one exists for a reason):

| Setting | Value | Why |
|---|---|---|
| `PONDER_RPC_URL` | comma-separated **failover pool** (`sepolia.drpc.org`, `sepolia.gateway.tenderly.co`) | Ponder rotates when an endpoint throttles; both validated for 1000-block `eth_getLogs` |
| `ethGetLogsBlockRange` | `1000` | Sparse-event contracts: a backfill costs a handful of wide getLogs calls instead of thousands of narrow ones |
| `pollingInterval` | `15_000` (Sepolia) / `1_000` (Anvil) | Ponder's 1 s default is sized for a local chain; against Sepolia's ~12 s blocks it burns ~86k requests/day for nothing. 15 s trades ~one block of latency for a ~15× cut in steady RPC load |

## Field note — never point Ponder at an Alchemy Free endpoint

The one production incident of this project, kept here because it generalizes: Alchemy's
Free tier hard-caps `eth_getLogs` at a **10-block range**. Ponder reacts to the resulting
400s by shrinking its request windows — which multiplies the request count, which trips
the rate limiter, which produces more errors: a self-amplifying **429 spiral** (~1,300
calls to backfill a few hours of history, none of them completing the job). Nothing is
wrong with either tool; the *combination* of a range-capped provider and an adaptive
backfiller is structurally unstable.

The fix is workload separation, not a bigger plan: the indexer gets its own
getLogs-friendly endpoints (the failover pool above) with wide fixed ranges, while
Alchemy remains perfectly fine for the relayer and deploys (low volume, no `getLogs`).
If you swap RPC providers, validate the **getLogs range policy** first — it is the spec
that breaks indexers, not throughput.

## Schema — 8 derived tables

| Table | Source events | Contents |
|---|---|---|
| `payment` | `Settled`, `IntrabankTransfer` | Every payment, `kind: interbank\|intrabank`, parties, banks, amount |
| `stable_flow` | `StableMinted`, `StableRedeemed` | sEUR issuance/redemption, `kind: mint\|redeem`, client, bank |
| `ratio_breach` | `ReserveRatioBreached` | The central bank's alert wall (bank, ratio, threshold) |
| `bank_status_event` | `BankFrozen`, `BankUnfrozen` | Freeze history per bank |
| `client_event` | `ClientRegistered/Credited/Removed` | Registry event log (amount 0 for register/remove) |
| `client` | same | **Current** registry membership per bank (PK `bank+address`, `active` flag) |
| `seur_transfer` | `Transfer` (sEUR) | P2P transfers only — mint (`from == 0`) and burn (`to == 0`) legs excluded |
| `seur_holder` | `Transfer` (sEUR) | Running balance per holder (mint credits, burn debits, transfer does both) |

Every row carries block number, timestamp and tx hash. uint256 values use Ponder's
`bigint` columns. Banks A and B share one ABI, so their handlers delegate to shared typed
helpers — 17 indexing functions total.

## REST API

Hand-rolled with Hono instead of Ponder's auto-generated GraphQL: the JSON shape stays
predictable and decoupled from schema naming. All reads are public (they only mirror
public on-chain events); CORS is open; bigints are serialized as decimal strings; limits
are clamped server-side (default 50, max 500).

| Endpoint | Filters |
|---|---|
| `GET /payments` | `account` (sender or recipient), `bank` (either side), `limit` |
| `GET /stable-flows` | `account`, `limit` |
| `GET /ratio-breaches` | `bank`, `limit` |
| `GET /bank-status` | `bank`, `limit` |
| `GET /clients` | `bank`, `active=false` to include removed, `limit` (default 200) |
| `GET /seur-transfers` | `account` (either side), `limit` |
| `GET /seur-holders` | `limit` (default 20, max 100); balance > 0 only, sorted desc |

## Operational behavior

- **Fresh start / rebuild**: backfills from `startBlock`, then follows the head at the
  polling interval. The backfill cost grows with the chain's age since deployment —
  Sepolia adds ~7,200 blocks/day, so coming back weeks later means catching up on tens of
  thousands of blocks. That is precisely what the fixed 1000-block range absorbs (a week
  ≈ ~50 getLogs windows per contract, minutes of backfill) — and why the indexer exists
  at all: the frontend never rescans the chain; it asks the indexer, which has already
  caught up.
- **Accepted latency**: on Sepolia, history lags the chain head by **~30 s–2 min**
  (public endpoints + 15 s polling). This is a documented trade-off, not a bug: the
  frontend's *live* numbers (balances, reserves, ratios) are direct RPC reads and stay
  instant; only the history tables trail.
- **Run it**: `make indexer` (`CHAIN=local|sepolia`).

# Contracts reference

> Per-contract reference for the 7 Solidity sources (9 deployed instances). Solidity
> ^0.8.24, Foundry, OpenZeppelin v5, no upgradeability proxies (redeploy instead). Live
> addresses: [`deployments/sepolia.json`](../deployments/sepolia.json), all instances
> Etherscan-verified. Architecture-level context: [architecture.md](architecture.md).

**Shared conventions.** All tokens use 6 decimals (USDC style). Custom errors everywhere
(no revert strings); events in past tense; AccessControl roles named `*_ROLE`; NatSpec on
every external function; checks-effects-interactions. Institutions deploy their own token in
their constructor (atomic wiring — no window where token powers are unassigned).

---

## WCBDC — `wCBDC` (M0)

Restricted ERC-20 for wholesale central bank money. The `_update` hook enforces the holder
rule on every path: **mints require an allowlisted recipient, transfers require both ends
allowlisted** (invariant 4); burns are unrestricted so the central bank can wind down a
removed bank's stranded reserves.

| Function | Guard | Effect |
|---|---|---|
| `setAllowlisted(account, allowed)` | `DEFAULT_ADMIN_ROLE` (CentralBank) | Adds/removes a holder |
| `mint(to, amount)` / `burn(from, amount)` | `MINTER_ROLE` / `BURNER_ROLE` (CentralBank) | M0 issuance/destruction |
| `settle(from, to, amount)` | `SETTLER_ROLE` (SettlementEngine) | Moves reserves between banks, no allowance |

Events: `AllowlistUpdated`. Errors: `NotAllowlisted`.
Design note: the allowlist lives **in the token** (the transfer rule is self-contained);
CentralBank is its sole administrator.

## CentralBank

Deploys the wCBDC in its constructor and holds every admin power over it. Also owns the
system's one regulatory parameter.

| Function | Guard | Effect |
|---|---|---|
| `registerBank(bank)` / `removeBank(bank)` | `OPERATOR_ROLE` | Toggles the wCBDC allowlist (`isRegisteredBank` view) |
| `mintCBDC(bank, amount)` / `burnCBDC(bank, amount)` | `OPERATOR_ROLE` | M0 issuance — genesis only in V1 (invariant 1) |
| `setSettlementEngine(engine)` | `OPERATOR_ROLE` | Grants `SETTLER_ROLE` on wCBDC to the engine, revoking the previous one (re-settable) |
| `setReserveRatioThreshold(bps)` | `OPERATOR_ROLE` | The soft regulatory threshold (init 1,000 = 10%, max 10,000) |

Events: `BankRegistered/Removed`, `CBDCMinted/Burned`, `ReserveRatioThresholdUpdated`,
`SettlementEngineUpdated`. Errors: `ThresholdAboveMax`.

## CommercialBank — ×2 (Bank A, Bank B)

Holds the bank's reserves (`reserves() == wcbdc.balanceOf(this)`), the client registry
gating its DepositToken, and the freeze switch. Deploys its DepositToken in its
constructor.

| Function | Guard | Effect |
|---|---|---|
| `registerClient(client)` | `OPERATOR_ROLE` | Adds to `isClient` (reverts `AlreadyClient`) |
| `removeClient(client)` | `OPERATOR_ROLE` | Reverts `ClientHasBalance` while deposits remain — a removed client with a balance would break invariant 5 |
| `creditClient(client, amount)` | `OPERATOR_ROLE` | Mints deposits (genesis path; deliberately unlimited — "loans make deposits", V3 hook), then runs the soft ratio check |
| `onboard(client, amount)` | `FAUCET_ROLE` (relayer EOA) | Option B: register **and** credit in one call; `amount ≤ MAX_FAUCET_CREDIT` (1,000,000); one-shot per address (`AlreadyClient` on retry) |
| `freeze()` / `unfreeze()` | `OPERATOR_ROLE` | Pauses/unpauses the DepositToken (halts *all* deposit movement, settlements included) |
| `setSettlementEngine(engine)` | `OPERATOR_ROLE` | Grants/revokes the engine's `MINTER/BURNER/SETTLER` roles on the token |
| `checkReserveRatio()` | **none — permissionless** | Emits `ReserveRatioBreached(bank, ratioBps, thresholdBps)` if below threshold; writes nothing, blocks nothing (soft constraint) |

Views: `reserves()`, `reserveRatioBps()` (returns `type(uint256).max` when no deposits —
trivially covered). Events: `ClientRegistered/Removed/Credited`, `BankFrozen/Unfrozen`,
`SettlementEngineUpdated`, `ReserveRatioBreached`. Errors: `AlreadyClient`, `NotClient`,
`ClientHasBalance`, `FaucetAmountTooHigh`.

## DepositToken — ×2 (DEP-A, DEP-B) (M1)

Restricted, pausable ERC-20 for tokenized deposits. The `_update` hook queries the owning
bank's registry: **mints require a registered recipient, transfers (including `settle`)
require both ends registered** (invariant 5, enforced unconditionally — every legal engine
operation targets registered clients by construction, so no engine bypass exists). Burns
are role-gated only. `ERC20Pausable` then blocks *every* path while frozen — including the
engine's mint/burn/settle, which is what makes `freeze()` the future depeg trigger.

| Function | Guard |
|---|---|
| `mint` / `burn` | `MINTER_ROLE` / `BURNER_ROLE` (bank for genesis credit, engine for settlement) |
| `settle(from, to, amount)` | `SETTLER_ROLE` (engine) — intrabank book transfer, no allowance, supply untouched |
| `pause` / `unpause` | `PAUSER_ROLE` (the bank) |

Errors: `NotClient`. The registry interface (`IClientRegistry`) is declared locally to
avoid a circular import with the bank that deploys it.

## SettlementEngine

The system's core. Stateless apart from intent nonces (OZ `Nonces`, sequential per payer);
banks are validated against the CentralBank registry on every call.

```solidity
struct PaymentIntent {
    address from; address fromBank; address toBank; address to;
    uint256 amount; uint256 nonce; uint256 deadline; // deadline inclusive
}
```

| Function | Guard | Effect |
|---|---|---|
| `executeIntent(intent, signature)` | anyone (relay-agnostic) | Verification order: deadline → `ECDSA.recover` == `intent.from` → `_useCheckedNonce` (replay/gap reverts) → `_settle` → `IntentExecuted(digest, from, nonce)` |
| `hashIntent(intent)` | view | Canonical EIP-712 digest — shared by relayer, frontend and tests; also the relayer's idempotency key |
| `setStableCo(stableCo)` | central bank operator (checked via `centralBank.hasRole` — no role lives on the engine) | Wires the vault; caches `stableCo` **and** `stableCoBank` (read from `StableCo.bankA()`) so composition calls never trust a caller-supplied bank; re-settable |
| `settleToStable(from, fromBank, amount)` | `msg.sender == stableCo` | Mint leg: settles deposits *into* the vault (payee forced to StableCo/Bank A) |
| `settleFromStable(to, toBank, amount)` | `msg.sender == stableCo` | Redeem leg: settles deposits *out of* the vault (payer forced) |

`_settle` routes on `fromBank == toBank`: intrabank ⇒ `DepositToken.settle` book transfer
(`IntrabankTransfer`); interbank ⇒ explicit `InsufficientReserves(bank, required,
available)` pre-check (the ILLIQUID state, and the *only* thing that ever blocks a
payment), then atomically **burn DEP(payer) → `wcbdc.settle(fromBank → toBank)` → mint
DEP(payee)** (`Settled`, invariants 2 and 7), then the paying bank's soft ratio check.
The StableCo entry points consume **no engine nonce** — replay protection lives in
StableCo's own counter.

Events: `Settled`, `IntrabankTransfer`, `IntentExecuted`, `StableCoUpdated`. Errors:
`ZeroAmount`, `NotRegisteredBank`, `NotBankClient`, `InsufficientReserves`,
`IntentExpired`, `InvalidIntentSigner`, `NotStableCo`, `NotCentralBankOperator`.

## StableCo

Reserve vault and sEUR issuer; a registered client of Bank A, where its DEP-A reserves
live. Deploys sEUR in its constructor (sole admin/minter/burner — **no EOA can mint**).
Verifies client-signed intents with its own sequential nonce namespace.

```solidity
struct MintIntent   { address minter;   address minterBank;   uint256 amount; uint256 nonce; uint256 deadline; }
struct RedeemIntent { address redeemer; address redeemerBank; uint256 amount; uint256 nonce; uint256 deadline; }
```

| Function | Guard | Effect |
|---|---|---|
| `mintFromIntent(intent, sig)` | anyone, `whenNotPaused` | `engine.settleToStable` **then** `seur.mint` — reserves arrive before issuance (coverage-safe, invariant 3); `StableMinted` |
| `redeemFromIntent(intent, sig)` | anyone, `whenNotPaused` | `seur.burn` **then** `engine.settleFromStable` — supply shrinks before reserves leave; `StableRedeemed` |
| `hashMintIntent` / `hashRedeemIntent` | view | Canonical digests (idempotency keys) |
| `pause()` / `unpause()` | `OPERATOR_ROLE` | The operator's **only** power |

Views: `reserves()` (= `depA.balanceOf(this)`), `coverageRatioBps()` (max sentinel when no
supply). No same-bank/cross-bank branching exists here — the engine routes from the
client's bank. The redeem burn takes no allowance: the signed `RedeemIntent` is the
authorization, and StableCo is the sole `BURNER_ROLE` holder. Errors: `ZeroAmount`,
`IntentExpired`, `InvalidIntentSigner`.

## StableEUR — `sEUR`

Permissionless ERC-20 (no holder allowlist — it keeps circulating when the issuer is
paused or a bank is frozen) plus the **complete EIP-3009 surface** with random 32-byte
nonces and a per-authorizer used-nonce map:

| Function | Guard | Notes |
|---|---|---|
| `mint` / `burn` | `MINTER_ROLE` / `BURNER_ROLE` — held **only** by StableCo | Supply is endogenous; no admin mint exists by design |
| `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, sig)` | anyone | The gasless P2P path (relayer submits) |
| `receiveWithAuthorization(...)` | `msg.sender == to` | Payee-only submission (front-running protection); implemented for EIP-3009 conformance, not routed by the relayer |
| `cancelAuthorization(authorizer, nonce, sig)` | signer | Invalidates a leaked/stale unused authorization |
| `authorizationState(authorizer, nonce)` | view | True once used or cancelled |

Validity window is strict at both ends (`validAfter < now < validBefore`, per EIP-3009).
EIP-712 domain: `("Stable EUR", "1")`. Events: `AuthorizationUsed`,
`AuthorizationCanceled`. Errors: `AuthorizationNotYetValid`, `AuthorizationExpired`,
`AuthorizationAlreadyUsed`, `InvalidAuthorizationSigner`, `CallerNotPayee`.

---

## EIP-712 domains

| Contract | Domain | Signed types |
|---|---|---|
| SettlementEngine | `("SettlementEngine", "1")` | `PaymentIntent` |
| StableCo | `("StableCo", "1")` | `MintIntent`, `RedeemIntent` |
| StableEUR | `("Stable EUR", "1")` | `TransferWithAuthorization`, `ReceiveWithAuthorization`, `CancelAuthorization` |

All domains bind `chainId` and `verifyingContract`, so a signature is worthless on any
other chain or contract instance. The relayer and frontend mirror these types byte-for-byte
(`relayer/src/intent.ts`, `frontend/src/lib/eip712.ts`) and cross-check digests against the
contracts' `hash*` views. Three nonce namespaces coexist and are never unified — see
[architecture.md §2.5](architecture.md).

## Invariants ↔ code map

| # | Invariant | Enforced by | Checked in |
|---|---|---|---|
| 1 | `wCBDC.totalSupply() == 1,000,000` (V1) | `mintCBDC` used at genesis only (convention) | `invariant_M0SupplyConstant` |
| 2 | Interbank M1 moves ⇔ equal M0 move, same tx | `_settle` atomic legs | `invariant_SettlementCoupling` (aggregate form: `deposits − reserves == genesis loans`, pinned forever) |
| 3 | `sEUR.totalSupply() ≤ DEP-A(StableCo)` | Coverage-safe ordering in StableCo | `invariant_StableCoverage` |
| 4 | Only allowlisted banks hold wCBDC | `WCBDC._update` | `invariant_OnlyBanksHoldM0` |
| 5 | Only registered clients hold a bank's DEP | `DepositToken._update` + `removeClient` balance guard | `invariant_OnlyClientsHoldDEP` |
| 6 | No replay of intents/authorizations | 3 nonce namespaces + deadlines/windows | Unit tests (replay, gap, expiry) |
| 7 | Payments conserve aggregate value | burn == settle == mint in `_settle` | `invariant_M1AggregateConstant`* + round-trip integration test |

\* A *test-suite* invariant, not a system one: it holds because the fuzz handler never
calls `creditClient` — the system deliberately allows M1 growth through operator credit.

## Test suite

**155 Foundry tests**: 132 unit (`test/unit/`, one file per contract), 17 integration
(`test/integration/Settlement.t.sol` + `Stablecoin.t.sol` — the scenario walk-throughs in
[scenarios.md](scenarios.md) cite them), 6 invariant properties
(`test/invariant/Invariants.t.sol`) driven by a bounded, never-reverting handler through
random payment/mint/redeem/freeze sequences at 128 runs × depth 64 with
`fail_on_revert = true` — any revert in a fuzzed sequence is a bug, not noise. Payments in
the handler travel the production path: real EIP-712 signatures, submitted by a third
party. `forge fmt --check` clean.

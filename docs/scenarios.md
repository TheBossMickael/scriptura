# Scenarios — numbered walk-throughs

> Every scenario below is executable: each one cites the Foundry integration test that
> proves it (`contracts/test/integration/`), and four of them link to real, verified
> transactions from the end-to-end run on live Sepolia (2026-07-02). Amounts are whole
> units (all tokens use 6 decimals).

**Genesis state** (the starting point of every scenario):

| | Bank A | Bank B |
|---|---|---|
| wCBDC reserves | 500,000 | 500,000 |
| Deposits (DEP) | 4,000,000 (alice1: 2,400,000 · alice2: 1,600,000) | 4,000,000 (bob1: 2,400,000 · bob2: 1,600,000) |
| Reserve ratio | 12.5% | 12.5% |
| "Loans" (documented convention) | 3,500,000 | 3,500,000 |

Regulatory threshold 10%. M0 total 1,000,000 (constant). StableCo starts empty.

---

## S1 — Intrabank payment: a book transfer, nothing more

alice1 pays alice2 **200,000** (both at Bank A). One `DepositToken.settle` book transfer:
alice1 2,400,000 → 2,200,000, alice2 1,600,000 → 1,800,000. **Nothing else moves** — DEP-A
supply, Bank A's reserves and ratio, M0: all untouched. Money changed hands inside one
bank's ledger; no settlement was needed.
Events: `IntrabankTransfer`, `IntentExecuted`.
Proof: `test_IntrabankPayment_MovesDepositsOnly`.

## S2 — Interbank payment: settled in central bank money

alice1 pays bob1 **100,000** (Bank A → Bank B). Three legs, one transaction:

| | Before | After |
|---|---|---|
| alice1 DEP-A | 2,400,000 | 2,300,000 (burned) |
| Bank A reserves | 500,000 | 400,000 (wCBDC left) |
| Bank B reserves | 500,000 | 600,000 (wCBDC arrived) |
| bob1 DEP-B | 2,400,000 | 2,500,000 (minted) |
| Bank A ratio | 12.5% | **10.25%** (400,000 / 3,900,000) |
| Bank B ratio | 12.5% | **14.63%** (600,000 / 4,100,000) |

M0 supply unchanged — it circulates, it is never created by a payment. The payer's ratio
degrades; the receiver's mechanically improves (its reserves and deposits grew by the same
amount). alice1's intent nonce advanced to 1; the relayer paid the gas, alice1 paid only
deposits. Events: `Settled`, `IntentExecuted`.
Proof: `test_InterbankPayment_SettlesInCentralBankMoney`.
Live on Sepolia (100 DEP interbank payment, exact wCBDC settlement):
[`0x353d…bd9c`](https://sepolia.etherscan.io/tx/0x353d57e3d9122827c60015d4811a9e94bbd146cb534ea1e72c92f2debb82bd9c) (block 11182949).

## S3 — Regulatory breach: flagged, never blocked

alice1 pays bob1 **150,000**. Bank A lands at 350,000 / 3,850,000 = **9.09% < 10%**: the
settlement **still executes** — the bank emits `ReserveRatioBreached(bankA, 909, 1000)`
and is now 🟠 STRESSED. The ratio is monitored, not enforced per transaction; only
physics (S4) blocks payments. From genesis, any cumulative net outflow beyond
**≈ 111,111** breaches the threshold — each withdrawal worsens the published ratio, which
is exactly the signal that motivates the next one (the run mechanic, staged fully in V2).
Proof: `test_InterbankPayment_BreachesRatioAndStillSettles`.

## S4 — Illiquidity: the hard stop (and what it doesn't stop)

Outgoing settlements drain Bank A's reserves to **0** (e.g. a 500,000 payment). The next
interbank payment — even of 1 — reverts with `InsufficientReserves(bankA, 1, 0)`: Bank A
is 🔴 ILLIQUID. But **illiquid is not frozen**: an intrabank payment from alice2 to alice1
still works, because book transfers need no reserves. Illiquid is also not insolvent —
the balance sheet still balances; the bank simply cannot pay *across* right now.
Proof: `test_RevertWhen_BankIlliquid_IntrabankStillWorks`.

## S5 — Freeze: everything stops, in both directions

Bank A's operator calls `freeze()`. All DEP-A movement halts: intrabank transfers,
outgoing settlements (the burn is paused) — and **incoming** settlements too (the mint is
paused): money cannot enter a frozen bank either. A reverted intent consumes nothing (the
transaction rolls back, nonce included), so the same signed intents can be resubmitted
after `unfreeze()`. Bank B is entirely unaffected — the freeze is strictly local.
Events: `BankFrozen`, `BankUnfrozen`.
Proof: `test_Freeze_BlocksAllDepositMovementBothDirections`, `test_Unfreeze_ResumesSettlement`.

## S6 — Mint/redeem sEUR, same bank: a book transfer plus issuance

alice1 (Bank A) mints **100,000 sEUR**: her DEP-A moves to the StableCo vault as an
intrabank book transfer (no central bank money involved), then 100,000 sEUR is minted to
her. Redeeming **40,000** runs the exact mirror: burn first, then the vault's DEP-A flows
back. Coverage sits at exactly 100% throughout.
Events: `StableMinted` / `StableRedeemed` (+ the underlying `IntrabankTransfer`).
Proof: `test_MintSameBank_BookTransferThenIssue`, `test_RedeemSameBank_BurnThenBookTransfer`.

## S7 — Cross-bank mint: five accounting moves, one transaction

bob1 (Bank B) mints **100,000 sEUR**. His deposits cannot simply move to the vault (it
banks at A), so the vault composes an interbank settlement in the same transaction:

1. burn 100,000 DEP-B (bob1) →
2. wCBDC 100,000 moves B → A (Bank B 400,000 / Bank A 600,000) →
3. mint 100,000 DEP-A to the vault →
4. mint 100,000 sEUR to bob1
   — with (0) the intent verification up front: five moves across all three monetary
   layers, atomically. Coverage never dips below 100% (reserves arrive *before* issuance).

Proof: `test_MintCrossBank_ComposesInterbankSettlement`.
Live on Sepolia (10,000 sEUR minted cross-bank by a Bank B client):
[`0x2479…6fb4`](https://sepolia.etherscan.io/tx/0x2479416390635aaa779b5e44671fb8b76ee906e9e3c98a5806afc231f1176fb4) (block 11182780).

## S8 — Cross-bank redeem: the mirror, and its hard failure mode

bob1 redeems **60,000 sEUR**: burn the sEUR, burn 60,000 DEP-A from the vault, settle
wCBDC A → B, mint 60,000 DEP-B back to bob1. The wCBDC round-trip is exact to the cent.

The instructive failure: drain Bank A's reserves (via S4-style payments), then try a
cross-bank redeem. The reverse settlement A → B hits `InsufficientReserves` — and because
the sEUR burn happened *first in the same transaction*, **everything rolls back, burn
included**: the redeemer keeps their sEUR; no value is ever destroyed by a failed exit.
A stablecoin exit is only as liquid as the bank its reserves sit at — the contagion
mechanic, reduced to one revert.
Proof: `test_RedeemCrossBank_ComposesReverseSettlement`, `test_RevertWhen_RedeemCrossBank_BankAIlliquid`.
Live on Sepolia (cross-bank redeem, composed A→B):
[`0x9efa…6dba`](https://sepolia.etherscan.io/tx/0x9efa70987de35966b4b5bc67ded47502e0a7f6c378df9fbc1d734c0d02916dba) (block 11182996).

## S9 — Frozen bank, living stablecoin

With Bank A frozen, mint and redeem both revert (`EnforcedPause` — the DEP-A leg cannot
move), but **sEUR itself keeps circulating**: alice1 transfers 30,000 sEUR to bob1 while
her bank is frozen. Intermediated money dies with its infrastructure; permissionless money
does not. This is the mechanical core of the V2 depeg scenario (frozen reserves → broken
redemption arbitrage).
Proof: `test_FreezeBankA_BlocksMintRedeem_ButSEURStillFlows`.

## S10 — sEUR peer-to-peer: two paths, two trust models

Same 25,000 sEUR transfer, two ways:
- **Gasless (EIP-3009)**: alice1 signs a `TransferWithAuthorization` (random 32-byte
  nonce, validity window); the *relayer* submits and pays gas. alice1 needs zero sETH.
- **Direct**: alice1 calls `transfer()` herself and pays her own gas. No intermediary at
  all — works even with the relayer offline.

Proof: `test_P2P_GaslessEIP3009_RelayerSubmits`, `test_P2P_DirectTransfer_HolderPaysOwnGas`.
Live on Sepolia (gasless EIP-3009 transfer):
[`0x8634…e6d2`](https://sepolia.etherscan.io/tx/0x8634ea701d8636c9885ccb665a39fe7c4e311c6ab6acf5c60a4577a09e8fe6d2) (block 11182957).

## S11 — Replay, idempotency, ordering

Submitting the **same signed intent twice**: the relayer answers with the original result
(`idempotent: true`, same txHash) — and even bypassing the relayer, the engine's
`_useCheckedNonce` reverts on-chain. An intent with a **stale nonce** is rejected `409
nonce_mismatch` before any gas is spent. Sequential nonces also impose ordering: one
in-flight action per client (the UI disables buttons accordingly). Validated in unit
tests (replay/gap/expiry) and live in the Sepolia E2E run.

## S12 — Conservation: the round trip

A pays B 150,000, then B pays A 150,000 back: **every** aggregate — balances, deposit
supplies, reserves, ratios, M0 — returns exactly to its genesis value. Settlement moves
value around; it never creates or destroys any (invariant 7).
Proof: `test_RoundTrip_RestoresGenesisState`.

---

## Live validation — the Sepolia E2E run (2026-07-02)

The full user journey was executed protocol-level against the live deployment (fresh
wallets driven exactly as the frontend does: faucet → EIP-712/EIP-3009 signatures →
relayer): Option B onboarding at both banks (one-shot enforced — the second faucet call
returns `409 AlreadyClient`), intrabank + interbank payments, same-bank **and cross-bank
mint/redeem**, gasless EIP-3009 transfer, replay idempotency and stale-nonce rejection.
All seven invariants were re-verified on-chain after every step, to the cent.

| Flow | Tx (sepolia.etherscan.io) | Block |
|---|---|---|
| Cross-bank mint (10,000 sEUR, composed B→A) | [`0x2479…6fb4`](https://sepolia.etherscan.io/tx/0x2479416390635aaa779b5e44671fb8b76ee906e9e3c98a5806afc231f1176fb4) | 11182780 |
| Interbank payment (100 DEP, exact wCBDC settlement) | [`0x353d…bd9c`](https://sepolia.etherscan.io/tx/0x353d57e3d9122827c60015d4811a9e94bbd146cb534ea1e72c92f2debb82bd9c) | 11182949 |
| Gasless sEUR transfer (EIP-3009) | [`0x8634…e6d2`](https://sepolia.etherscan.io/tx/0x8634ea701d8636c9885ccb665a39fe7c4e311c6ab6acf5c60a4577a09e8fe6d2) | 11182957 |
| Cross-bank redeem (composed A→B) | [`0x9efa…6dba`](https://sepolia.etherscan.io/tx/0x9efa70987de35966b4b5bc67ded47502e0a7f6c378df9fbc1d734c0d02916dba) | 11182996 |

## V2 preview (out of scope, mechanics in place)

- **Bank run**: agent clients following "if my bank's ratio < X%, flee" — S2's ratio
  mechanics plus S3's public breach signal make the cascade self-fueling.
- **Depeg**: `freeze()` Bank A → redemptions revert (S8/S9) → sEUR trades below par once
  a market price exists (V3 AMM).
- **Relayer outage/censorship**: DEP payments stall (operationally — self-relay remains
  possible), sEUR keeps moving (S10's direct path).

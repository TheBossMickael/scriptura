# Monetary design — why the system looks like this

> The "why" behind Two-Tier Money: what the two-tier monetary system is, which of its
> properties this project demonstrates on-chain, and which design decisions encode them.
> For the "how" (contracts, roles, flows), see [architecture.md](architecture.md) and
> [contracts.md](contracts.md). Numbers below are the genesis state (all tokens use
> 6 decimals; amounts are quoted in whole units).

---

## 1. Two tiers: money as a hierarchy of claims

Most of what we call "money" is not central bank money. The system has (at least) two layers:

- **M0 — central bank money.** A liability of the central bank, held here only by
  commercial banks as reserves. It is the *final* settlement asset: it is not a claim on
  anything else. Tokenized as **wCBDC** (wholesale CBDC — banks only, never end users).
- **M1 — commercial bank money.** Your bank balance is not euros at the central bank; it
  is a *claim on your bank*, a liability the bank owes you. Tokenized as **DEP-A / DEP-B**,
  one deposit token per bank, holdable only by that bank's registered clients.

Each layer is a debt of the layer above: Alice holds a claim on Bank A, and Bank A holds a
claim on the central bank.

```
Alice ──claim──▶ Bank A (DEP-A) ──claim──▶ Central bank (wCBDC)
```

The guiding implementation principle is **"the EOA decides, the contract enforces, the
token accounts"**: every rule-bound balance lives in a contract (banks hold reserves,
StableCo holds its deposit reserves), never on an operator's EOA. An EOA can promise;
a contract *is* the rule — inspectable, composable, and testable as invariants.

**Genesis**: 1,000,000 wCBDC total (500,000 per bank); 4,000,000 deposits per bank,
deliberately split unevenly across its two clients (2,400,000 / 1,600,000); initial
reserve ratio 12.5% against a 10% regulatory threshold. The two banks start perfectly
symmetric, so any later divergence between them is the visible trace of a flow. Each
bank's balance sheet carries a documented, non-tokenized "loans = 3,500,000" line so that
assets (reserves + loans) equal deposits at genesis.

## 2. The singleness of money — settled, not assumed

Why is one euro at Bank A worth exactly one euro at Bank B, when they are claims on two
different private institutions? Because every transfer between banks is **settled in
central bank money**. That is the core mechanism this project demonstrates, and it is
enforced *atomically*:

An interbank payment (Alice at Bank A pays Bob at Bank B) executes three legs in **one
transaction** ([`SettlementEngine._settle`](../contracts/src/SettlementEngine.sol)):

1. **Burn** Alice's DEP-A — Bank A's debt to Alice is extinguished;
2. **Move** the same amount of wCBDC from Bank A's reserves to Bank B's;
3. **Mint** DEP-B to Bob — Bank B takes on a new debt, fully funded by the reserves it
   just received.

Equal amounts of M1 burned, M0 moved, and M1 minted — or nothing (invariants 2 and 7).
No commercial bank money ever crosses banks unbacked, so a DEP-A euro and a DEP-B euro
remain interchangeable: that is the *singleness of money*, made mechanical.

A payment between two clients of the same bank, by contrast, is a pure **book transfer**
on that bank's ledger: no central bank money moves, deposit supply is untouched. The
engine routes the two cases automatically from the payer's and payee's banks.

Real-world systems achieve this with an RTGS — in the euro area, TARGET2/T2 — where the
payment message and the settlement are separate steps in separate systems. Here they are
literally the same transaction, which is the promise usually attached to tokenized
"unified ledger" designs (see §7).

## 3. Fractional reserves, and what actually stops a payment

Each bank holds only a fraction of its deposits as reserves (12.5% at genesis) — the rest
is notionally lent out. This is the structural assumption that makes banking fragile and
the demo interesting: without it there is no bank run, no liquidity stress, nothing to
watch.

The design separates two constraints that are often conflated:

| Constraint | Trigger | Effect |
|---|---|---|
| **Hard (physical)** | Bank's wCBDC balance < settlement amount | The payment **reverts** (`InsufficientReserves`) — the only thing that ever blocks a payment |
| **Soft (regulatory)** | Reserve ratio < threshold (10%) | The payment **goes through**; the bank emits `ReserveRatioBreached` and keeps paying |

This mirrors reality: a regulatory ratio is *monitored*, not checked per transaction, and
it makes stress **gradual and observable** — three health states instead of a binary:

- 🟢 **HEALTHY** — ratio ≥ threshold;
- 🟠 **STRESSED** — ratio below threshold, reserves still positive, still paying;
- 🔴 **ILLIQUID** — reserves cannot cover the next payment: it reverts. Illiquid ≠
  insolvent — the balance sheet still balances; the bank just cannot pay *now*.

The ratio mechanics are worth stating: an outflow reduces reserves and deposits by the
same absolute amount, so the *ratio* falls (the numerator is the smaller side). From
genesis, roughly **111,000 in net outflows** pushes a bank under the 10% threshold — small
enough that a demo can trigger it, and small enough to show why runs are self-reinforcing:
each withdrawal makes the published ratio worse, which is precisely the signal that
convinces the next depositor to leave — the classic Diamond–Dybvig coordination problem.
Orchestrated run scenarios are V2 scope; the mechanics are fully in place.

## 4. The stablecoin: endogenous supply, reserves you can read

**sEUR** is a fiat-backed stablecoin issued by **StableCo**, a reserve vault that is
itself a registered *client of Bank A*: its reserves are DEP-A, i.e. commercial bank
money. That adds a third link to the claim chain — an sEUR holder holds a claim on
StableCo, which holds a claim on Bank A, which holds a claim on the central bank — and a
built-in **contagion channel**: trouble at Bank A is trouble for the stablecoin
(the USDC/SVB March 2023 pattern; the freeze-driven depeg is a V2 scenario, but
freezing Bank A already blocks mint/redeem today while sEUR itself keeps circulating).

Reserves are 100% bank deposits **on purpose** — more concentrated than what MiCA would
require of an e-money token issuer (which must keep a *floor* of its reserves as bank
deposits, 30% or 60% depending on significance, precisely to limit this coupling). The
demo maximizes the channel it wants to exhibit.

Two design decisions follow from having reserves *on-chain*:

- **No admin mint.** sEUR supply is **endogenous**: minted only when reserves arrive,
  atomically, directly to the buyer; burned on redemption. There is no operator mint
  function to misuse — the coverage invariant `sEUR supply ≤ StableCo's DEP-A balance`
  holds at every step, guaranteed by operation ordering (mint: reserves in *before*
  issuance; redeem: burn *before* reserves out). A real-world issuer like Circle needs a
  privileged minter because its reserves are off-chain and invisible to the contract;
  here issuance can be fully programmatic, so it is.
- **Proof of reserves is a view call**, not an attestation: coverage = two on-chain reads.
  The operator's only power is `pause()`/`unpause()` of issuance — a healthy issuer is
  boring by construction.

When a **Bank B** client mints or redeems, the vault composes an interbank settlement in
the same transaction (deposits cannot simply cross banks — the registries forbid it):
redeem by Bob = burn sEUR → burn the vault's DEP-A → wCBDC moves A to B → Bob receives
DEP-B. One intent, one transaction, four token movements across all three monetary
layers — the richest flow in the system.

## 5. Intermediated vs permissionless money

The deposit tokens and the stablecoin are deliberately built on opposite philosophies:

- **DEP** is *intermediated* money: holdable only by registered clients, freezable by the
  bank, and moved in practice through a relayer. It can be censored at three levels
  (registry, freeze, relayer downtime).
- **sEUR** is *permissionless* money: no allowlist, and it keeps circulating even when its
  issuer is paused or the bank backing it is frozen. It supports two peer-to-peer paths —
  a plain `transfer()` where the holder pays gas, and a gasless EIP-3009
  `transferWithAuthorization` where anyone can submit the holder's signed authorization.

The contrast is a demonstration in itself: when the infrastructure stops (relayer down,
bank frozen — V2 stages this as a scenario), DEP is dead and sEUR still moves.

## 6. The transparency paradox

Everything in this system is public: reserves, ratios, coverage, every settlement, every
breach. Flagging a breach is itself **permissionless** — `checkReserveRatio()` is a public
function anyone can call, because it only states an already-public fact.

That transparency is what makes the system trustworthy (proof of reserves, verifiable
settlement) — and it is also what would make a panic *faster*: every depositor watches the
same collapsing ratio in real time, first-come-first-served. Radical transparency does not
remove the run equilibrium; it accelerates coordination toward it. The observer dashboard
makes this concrete: the "information that triggers your panic" (your bank's live ratio)
is the same screen for everyone.

## 7. Real-world anchors

Kept deliberately brief — each of these is a pointer, not an essay:

- **TARGET2 / T2 (Eurosystem RTGS).** Interbank obligations settle in central bank money;
  this project compresses messaging and settlement into a single atomic transaction. Its
  October 2020 outage (~10 hours) is also the honest parallel for this project's single
  relayer being an assumed single point of failure (see
  [threat-model.md](threat-model.md)).
- **BIS Project Agorá / "unified ledgers".** The idea of putting tokenized commercial bank
  deposits and tokenized central bank money on shared programmable infrastructure so that
  settlement is atomic — which is, at demo scale, exactly this repository. Who operates
  such a ledger is an open governance question in the real projects; here the role matrix
  in [threat-model.md](threat-model.md) is that question, answered in miniature.
- **MiCA.** sEUR is structurally an e-money token (EMT): 1:1 redeemable, fiat-referenced,
  reserve-backed. The 100%-deposits reserve choice inverts MiCA's diversification logic on
  purpose (§4).
- **USDC / SVB (March 2023).** The reference event for TradFi→stablecoin contagion: reserves
  trapped at a failing bank → instant depeg. The V2 depeg scenario is this event, staged
  with a `freeze()`.
- **Bagehot / lender of last resort.** Out of V1 scope, but the design leaves the hook:
  the ILLIQUID-but-solvent state is exactly the situation a LOLR (V2) exists to resolve —
  lend freely, against good collateral, at a penalty rate.

## 8. Why plain ERC-20 hooks, and not ERC-1404 / ERC-3643

The holder restrictions (banks-only for wCBDC, registered-clients-only for DEP) are
implemented as a few lines in each token's `_update` hook, not as a compliance-token
standard. This is a considered choice, not an omission:

- The restriction logic is small enough that a standard interface would add surface
  without adding safety — and the tokens are invariant-tested as they are.
- **ERC-1404** (`detectTransferRestriction`) would standardize the *error reporting* of
  the same rules; **ERC-3643** (T-REX + ONCHAINID) is the production-grade answer, adding
  identity claims, qualified investors, and transfer compliance modules — the direction a
  regulated, MiCA-supervised deployment would take. Both are documented as the upgrade
  path; implementing them would refactor frozen, tested, deployed contracts for no
  demonstrative gain in V1.

## 9. The invariants, in monetary terms

The properties above are not prose — they are the Foundry invariant suite
([`Invariants.t.sol`](../contracts/test/invariant/Invariants.t.sol)), checked against
randomized sequences of payments, mints, redeems and freezes:

1. **M0 is constant** (1,000,000): central bank money only circulates in V1 — never
   created or destroyed after genesis.
2. **No M1 crosses banks without an equal M0 movement in the same transaction** (the
   singleness mechanism, §2).
3. **sEUR is always ≥100% covered** by StableCo's DEP-A reserves (§4).
4. **Only allowlisted banks ever hold wCBDC.**
5. **Only registered clients ever hold a bank's deposits.**
6. **No intent or authorization can be replayed** (sequential nonces for payments and
   mint/redeem; random EIP-3009 nonces for sEUR authorizations).
7. **Payments conserve aggregate value**: burn(DEP) == wCBDC moved == mint(DEP).

A change that violates any of these is not a variant of the design — it is a different
(and wrong) monetary system.

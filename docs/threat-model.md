# Threat model

> Proportionate by design: this is an educational system on a testnet, so the model focuses
> on what is genuinely load-bearing — signature/replay safety, key blast radius, and the
> honest single point of failure — and skips security theater. The last line of defense is
> always the same: **authorization lives on-chain (`onlyRole` / signature checks), nowhere
> else**; every off-chain check exists only to save gas on doomed transactions.

## 1. Powers and blast radius

What each key can do, and the worst case if it leaks:

| Key | Powers | Worst case if compromised |
|---|---|---|
| Central bank operator | Bank allowlist, M0 mint/burn, ratio threshold, engine/StableCo wiring | Full monetary takeover — **god mode by design** (it models the sovereign; V1 accepts this trust anchor) |
| Bank operator (A/B) | Register/remove clients, unlimited `creditClient`, freeze/unfreeze, engine wiring for its bank | Inflate its own M1 (realistic — "loans make deposits"), freeze its bank; cannot touch the other bank, M0 or sEUR |
| StableCo operator | `pause()` / `unpause()` issuance — nothing else | Halt mint/redeem. Cannot mint sEUR (no such function exists), cannot move reserves |
| Relayer | Its own gas + `FAUCET_ROLE` (`onboard` only) | Spend its own sETH; create test deposits capped at `MAX_FAUCET_CREDIT` per address, one-shot. **Cannot** impersonate clients (it holds no client keys and none are derivable — no mnemonic), freeze, or rewire |
| Client | Sign intents over their own funds | Loss limited to that client's balances |

The deliberate shape: powers decrease sharply down the table, and the component most
exposed to the internet (the relayer) holds the least.

## 2. Attack surfaces

**Replay & signature forgery.** All client authority is EIP-712, domain-bound to
`chainId` + contract instance, with three separate anti-replay namespaces (sequential
engine nonces, sequential StableCo nonces, random EIP-3009 nonces) plus
deadlines/validity windows; recovery uses OZ `ECDSA` (malleability-safe). A replayed
intent is refused off-chain (idempotency cache, nonce pre-check) and, decisively,
on-chain. Covered by unit tests (replay, gap, expiry, tampered payloads, wrong signer).

**Relayer censorship / downtime — the assumed SPOF.** The relayer is a single point of
failure, accepted and documented (real settlement infrastructure has the same shape —
TARGET2's October 2020 outage stopped euro settlement for ~10 hours). Two mitigations are
structural: censorship is *operational, never contractual* — the engine and StableCo
accept a valid signed intent from **any** submitter, so a client can always self-relay by
paying their own gas; and sEUR's direct `transfer()` path needs no relayer at all. A V2
scenario stages exactly this failure.

**Relayer gas drain.** A malicious client can submit an unbounded stream of *valid*
micro-intents (they pass every pre-check) and burn the relayer's sETH. Accepted in V1
(known genesis clients + one-shot faucet visitors; `fund-check` alerts on low balance).
Hardening path: per-address rate limiting at the HTTP layer, minimum amounts.

**Faucet abuse (Option B).** `onboard` is capped on-chain per address and one-shot
(`AlreadyClient`), so the guarantee survives any relayer bug. Sybil onboarding across many
fresh addresses remains possible — each costs the relayer gas and mints only capped *test*
deposits (it grows M1, which the design treats as realistic operator credit). Off-chain
rate limiting is a documented future hardening, not a V1 control.

**Key management.** No HD mnemonic exists anywhere: a single seed would both concentrate
all secrets and let the backend *derive* client keys — i.e. forge their signatures. The
"EOA decides" boundary is cryptographic, not conventional. Operator keys on Sepolia are
throwaway testnet keys in a gitignored `.env` (an encrypted keystore is the documented
production posture); client keys exist only in wallets.

**Frontend/relayer checks are UX, not security.** Role-gated panels and pre-simulations
improve feedback; every privileged call is re-verified on-chain. Rendering an admin panel
to the wrong wallet yields reverts, not power.

**EIP-3009 submission semantics.** `transferWithAuthorization` is submitter-agnostic: a
front-runner who "steals" the call changes nothing — `from`, `to` and `value` are fixed by
the signature, and the nonce burns once. Where the payee must be the submitter,
`receiveWithAuthorization` (`msg.sender == to`) exists; `cancelAuthorization` lets a
signer kill a leaked, unused authorization.

**Monetary-design "non-vulnerabilities".** Three things that look like findings but are
the design: `creditClient` is unlimited (commercial banks create money by lending — the
bank operator is a trusted role and the invariant suite deliberately excludes it); a ratio
breach never blocks payments (soft constraint — only `InsufficientReserves` does); and
sEUR has no admin mint *to remove the trust assumption*, not by omission (coverage is
invariant-tested instead).

## 3. What the invariants defend

The seven invariants ([contracts.md](contracts.md)) are the security
spec in executable form: constant M0, settlement coupling, 100% sEUR coverage, holder
restrictions on wCBDC/DEP, no-replay, value conservation. They run as fuzzed
state-machine tests (`fail_on_revert`, production signing paths) — an exploit in scope for
this model would have to falsify one of them.

## 4. Out of scope

MEV/ordering games on a testnet, gas-price griefing, RPC-provider compromise, contract
upgradeability (none exists — redeploy is the upgrade path), oracles (none), and economic
attacks requiring a secondary market (no AMM until V3).

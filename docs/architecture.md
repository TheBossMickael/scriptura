# Architecture — notes de phases

> Notes incrémentales : chaque phase terminée ajoute ici une courte section décrivant ce qui
> a été construit et les choix libres effectués. Passe finale de rédaction en Phase 6.

---

## Phase 1 — Couche M0 : wCBDC + CentralBank (2026-06-10)

### Construit

- **`contracts/src/WCBDC.sol`** — ERC-20 restreint (6 décimales) : hook `_update` qui n'autorise
  un mint que vers un détenteur allowlisté et un transfert que si `from` ET `to` sont
  allowlistés ; rôles `MINTER_ROLE`/`BURNER_ROLE` (CentralBank) et `SETTLER_ROLE` (réservé au
  SettlementEngine, accordé en Phase 2) ; `settle(from, to, amount)` déplace des réserves entre
  banques sans approve.
- **`contracts/src/CentralBank.sol`** — déploie le wCBDC et en détient seul l'admin ; registre
  des banques (`registerBank`/`removeBank` → allowlist du token), émission M0
  (`mintCBDC`/`burnCBDC`), paramètre réglementaire `reserveRatioThresholdBps` (init 1 000 =
  10 %). `OPERATOR_ROLE` → EOA centralBankOperator (deployer).
- **`contracts/script/Deploy.s.sol`** — squelette de genèse : dérive le deployer du mnémonique
  HD (index 0), déploie CentralBank, écrit `deployments/<chain>.json` (adresses +
  `START_BLOCK`, piège #6 anticipé). TODO explicites pour les Phases 2–4.
- **Tests** : `test/unit/WCBDC.t.sol` (18) + `test/unit/CentralBank.t.sol` (15) — restrictions
  de transfert, rôles, events, bornes, mini-scénario de genèse (`totalSupply == 1_000_000e6`).
- **Outillage** : `contracts/foundry.toml` (solc 0.8.24, fs_permissions vers `../deployments`),
  OpenZeppelin v5.6.1 + forge-std v1.16.1, `Makefile` minimal (`build`, `test`, `fmt`,
  `fmt-check` — complété en Phase 3).

### Choix libres (consignés)

1. **Allowlist stockée dans WCBDC** (et non dans CentralBank) : la règle de transfert est
   auto-contenue dans le token ; CentralBank reste l'unique administrateur via
   `DEFAULT_ADMIN_ROLE`.
2. **WCBDC déployé par le constructeur de CentralBank** : câblage atomique, aucune fenêtre où
   un tiers détiendrait les pouvoirs admin du token.
3. **Seuil de ratio en basis points** (`1_000` = 10 %), borné à 10 000 ; consommé en Phase 2
   (contrainte soft uniquement, piège #4).
4. **Burn possible après retrait de l'allowlist** : la banque centrale peut toujours apurer les
   réserves d'une banque retirée du système (gardé par `BURNER_ROLE`, donc CentralBank seul).
5. **Genèse recalibrée validée par l'utilisateur (2026-06-10)** : wCBDC total 1 000 000
   (500 000/banque), DEP 2 400 000/1 600 000 par client (4 000 000/banque), ratio initial
   12,5 %, seuil 10 %, ligne « prêts » 3 500 000/banque. CLAUDE.md et docs/projet.md mis à
   jour en conséquence (remplace 3 000 / 15 % / 8 500).

### Vérification

`forge build` propre, `forge test` **33/33 verts**, `forge fmt --check` propre, dry-run de
`Deploy.s.sol` sur EVM locale OK (écrit `deployments/local.json`). Suite d'invariants : à
bootstrapper en Phase 2 (conformément au phasage CLAUDE.md).

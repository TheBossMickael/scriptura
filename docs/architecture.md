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

---

## Phase 2 — Couche M1 + règlement : banques, DEP, SettlementEngine (2026-06-12)

### Construit

- **`contracts/src/DepositToken.sol`** (déployé ×2 : DEP-A, DEP-B) — ERC-20 restreint
  (6 décimales) + `ERC20Pausable` : hook `_update` qui exige un client enregistré comme
  destinataire d'un mint et les deux extrémités clientes pour un transfert (burns gardés
  par rôle uniquement) ; rôles `MINTER/BURNER/SETTLER_ROLE` (engine) et `PAUSER_ROLE`
  (banque) ; `settle(from, to, amount)` déplace des dépôts entre clients sans allowance
  (miroir de `WCBDC.settle`). Interface `IClientRegistry` locale pour éviter l'import
  circulaire avec la banque.
- **`contracts/src/CommercialBank.sol`** (déployé ×2 : A, B) — déploie son DepositToken au
  constructeur (câblage atomique, pattern Phase 1) ; registre clients
  (`registerClient`/`removeClient`) ; `creditClient` (mint de dépôts, genèse/« les crédits
  font les dépôts ») ; `freeze()/unfreeze()` → pause du token ; `setSettlementEngine`
  (accorde/révoque les 3 rôles engine sur le token) ; vues `reserves()` et
  `reserveRatioBps()` ; `checkReserveRatio()` (cf. choix 3).
- **`contracts/src/SettlementEngine.sol`** — chemin direct `settle(fromBank, toBank, to,
  amount)` avec `from = msg.sender` ; cœur `_settle` : validations (banques enregistrées
  via CentralBank, clients des deux côtés, montant non nul), intrabank = transfert
  comptable (pas de wCBDC), interbank = burn DEP → `wcbdc.settle` → mint DEP atomiques
  avec pré-check `InsufficientReserves` explicite ; events `Settled` /
  `IntrabankTransfer` ; post-check soft du ratio de la banque payeuse.
- **`contracts/src/CentralBank.sol`** (étendu) — `setSettlementEngine` : accorde/révoque
  `SETTLER_ROLE` sur le wCBDC (le branchement anticipé en Phase 1).
- **`contracts/script/Deploy.s.sol`** (étendu) — déploie banques + engine, registre les
  banques, mint la genèse M0 (500 000/banque), câble l'engine (chaque opérateur de banque
  signe son propre `setSettlementEngine`) ; écrit les 7 adresses + `START_BLOCK` dans
  `deployments/<chain>.json`. Seed clients/DEP : Phase 3 (TODO conservé).
- **Tests** : `test/unit/DepositToken.t.sol` (16), `test/unit/CommercialBank.t.sol` (25),
  `test/unit/SettlementEngine.t.sol` (13), `test/integration/Settlement.t.sol` (8 : genèse,
  intrabank, interbank, breach-et-paie-quand-même, illiquidité-mais-intrabank-OK, freeze
  bidirectionnel, unfreeze, aller-retour conservatif).
- **Suite d'invariants bootstrappée** : `test/invariant/Invariants.t.sol` + handler borné
  (`payIntrabank`, `payInterbank`, `toggleFreeze` ; jamais de revert, `fail_on_revert =
  true` dans `foundry.toml`). Cinq propriétés : M0 constant (INV 1), seules les banques
  détiennent le wCBDC (INV 4), M1 agrégé constant (INV 7, cf. choix 8), seuls les clients
  détiennent les DEP (INV 5), couplage règlement « dépôts − réserves == prêts de genèse »
  (forme agrégée de l'INV 2).

### Choix consignés (1–3 = décisions utilisateur du 2026-06-12)

1. **Intrabank = vrai transfert** via `DepositToken.settle` gardé par `SETTLER_ROLE` —
   étend la matrice des rôles de projet.md §4 (engine = MINTER+BURNER+SETTLER sur les
   DEP). Pas de burn+mint : la supply DEP ne bouge jamais sur un paiement interne, et la
   trace d'events reste lisible (un seul `Transfer`).
2. **Chemin direct = échafaudage Phase 2, à RETIRER en Phase 3** quand `executeIntent()`
   arrivera (NatSpec explicite sur la fonction). La règle de routage réserve le double
   chemin au sEUR seul ; le scénario censure-du-relayer (V2) exige des DEP exclusivement
   intermédiés. `_settle` interne sera réutilisé tel quel par le chemin intent.
3. **Règle ratio-breach généralisée** : toute opération dégradant le ratio émet
   `ReserveRatioBreached` si elle le fait passer (ou maintient) sous le seuil — règlement
   interbancaire sortant ET `creditClient`. Logique factorisée dans
   `CommercialBank.checkReserveRatio()`, **permissionless** (pur constat d'état public,
   cohérent avec le paradoxe de transparence) ; l'event est donc émis par la banque, pas
   par l'engine. Toujours soft (piège #4) : rien n'est jamais bloqué par le ratio.
4. **`removeClient` revert si solde non nul** (`ClientHasBalance`) : un ex-client avec des
   DEP violerait l'INVARIANT 5 (solde échoué, intransférable).
5. **Pré-check `InsufficientReserves(bank, required, available)` explicite** dans l'engine
   avant le règlement interbancaire : le `wcbdc.settle` revertirait de toute façon, mais
   l'erreur nommée matérialise l'état ILLIQUIDE pour le front et les tests.
6. **`creditClient` = pouvoir de mint opérateur délibérément illimité** : réaliste
   (création monétaire par le crédit), chemin de genèse en V1, hook de la V3.
7. **Pas de bypass « caller == engine » dans le hook `_update`** : toutes les opérations
   légales de l'engine ciblent des clients par construction, donc la restriction de
   détention est appliquée inconditionnellement — plus strict que la formulation
   CLAUDE.md, même résultat.
8. **`invariant_M1AggregateConstant` est un invariant de la suite de tests, pas du
   système** : il ne tient que parce que le handler n'appelle jamais `creditClient`. Le
   système autorise délibérément la croissance de M1 par le crédit opérateur ; la V3
   reprendra ce fil (la ligne « prêts » deviendra réelle).

### Vérification

`forge build` propre, `forge test` **100/100 verts** (87 unitaires + 8 intégration +
5 invariants à 128 runs × 64 de profondeur, 0 revert), `forge fmt --check` propre,
dry-run de `Deploy.s.sol` sur EVM locale OK (écrit les 7 adresses + `START_BLOCK` dans
`deployments/local.json`).

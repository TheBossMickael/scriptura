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

---

## Phase 3 — Intents EIP-712 + relayer + infra (2026-06-13)

### Construit

- **`contracts/src/SettlementEngine.sol`** (refondu) — hérite d'OZ `EIP712` et `Nonces` ;
  `struct PaymentIntent{from, fromBank, toBank, to, amount, nonce, deadline}` +
  `PAYMENT_INTENT_TYPEHASH` ; **`executeIntent(intent, signature)`** : deadline (inclusive)
  → `ECDSA.recover` (revert `InvalidIntentSigner`) → `_useCheckedNonce` (anti-replay,
  INVARIANT 6) → `_settle` (cœur Phase 2 inchangé) → event `IntentExecuted(digest, from,
  nonce)`. `hashIntent(intent)` vue (parité de digest relayer/front/tests + clé
  d'idempotence). **Chemin direct `settle()` retiré** (échafaudage Phase 2). L'engine est
  **relay-agnostique** : n'importe qui peut soumettre un intent signé.
- **Tests contrats** — `SettlementEngine.t.sol` refondu autour des intents (25, dont
  deadline/wrong-signer/tampered/replay/nonce-gap/any-relayer/frozen-bank/`IntentExecuted`/
  digest EIP-712 recalculé) ; `Settlement.t.sol` (8) et le handler d'invariants convertis
  aux intents signés (soumetteur ≠ payeur, le payeur signe via `vm.sign`). Suite à
  **112 verts**, invariants toujours à 0 revert.
- **Genèse complète** — `GenesisSeed.s.sol` (base abstraite, logique idempotente :
  register/credit clients + funding sETH par top-up), `Deploy.s.sol` (seed complet + JSON
  enrichi : 7 contrats + annuaire des 8 acteurs + relayer + `chainId` + `START_BLOCK`),
  `Seed.s.sol` (re-seed seul, idempotent).
- **Relayer** (`relayer/`, Node 20 + TS + Fastify + zod + viem) — `POST /intent`
  (validation zod ; body `{type:"payment", intent, signature}`, le discriminateur `type`
  anticipe les messages sEUR de la Phase 4 ; pré-checks signature/deadline/nonce +
  `simulateContract` décodant les custom errors ; envoi sérialisé ; cache d'idempotence
  mémoire ; watcher de receipt `submitted→confirmed|failed`) ; `GET /health` ; boot
  (sanity chainId + adresse relayer, resync du nonce pending — piège #5) ; `fundCheck` ;
  smoke `send-intent.ts` + vitest (16).
- **Infra** — Makefile complété (`anvil`, `deploy-local/-sepolia`, `seed`, `up/down`,
  `fund-check`, `relayer-dev`), `docker-compose.yml` (service relayer seul ; front en
  Phase 5), `Dockerfile`, `.env.example`, `.gitignore`.

### Choix consignés

1. **EOA relayer = clé dédiée isolée** (et non un acteur de la liste verrouillée). À l'origine
   HD index 8 ; **abandonné le 2026-06-13 au profit de clés individuelles** (cf. choix 6).
2. **`settle()` retiré, engine relay-agnostique** : la censure du relayer est *opérationnelle*,
   pas *contractuelle* (un client peut s'auto-relayer en payant son gas). **Garde-fou
   Phase 4** : `StableCo` (un contrat) ne peut pas signer ECDSA → la composition cross-bank
   ajoutera son propre point d'entrée restreint sur `_settle` (rien à scaffolder maintenant).
3. **Event `IntentExecuted(digest, from, nonce)`** : corrélation signé→soumis→confirmé pour
   le relayer et le front (Phase 5).
4. **Relayer : Fastify + zod ; réponse à la soumission (pas au receipt)** — le front suivra
   « confirmé » via la chaîne (projet.md §7) ; watcher de receipt fire-and-forget qui met à
   jour le cache d'idempotence ; file d'envoi sérialisée + `nonceManager` viem.
5. **`Seed.s.sol` idempotent séparé** ; `deployments/<chain>.json` enrichi (acteurs, relayer,
   chainId).
6. **Pas de phrase mnémonique — clés privées individuelles + adresses clients** (décision
   utilisateur 2026-06-13, appliquée même en local). Le `.env` porte les `*_PK` des rôles
   *signataires serveur* (deployer/BC, opérateurs A/B) et les `*_ADDRESS` de tout le reste ;
   le relayer ne détient que `RELAYER_PK` (EOA gas-only) et n'a aucun moyen de dériver les
   clés des clients — frontière cryptographique cohérente avec « l'EOA décide ». `make anvil`
   utilise la mnémonique Anvil par défaut (ses comptes connus = les clés publiques du `.env`).
   Les clés *clients* ne vivent jamais dans le backend : MetaMask en Phase 5, et la seule
   exception est `ALICE1_PK` du smoke test (clé Anvil publique, dev only).

### TODO doc (Phase 6 — `threat-model.md`)

- **Relay-agnostique** : censure du relayer = opérationnelle, pas contractuelle ;
  auto-relais possible (un client soumet lui-même son intent signé en payant son gas).
- **Épuisement du sETH du relayer** : un client malveillant peut drainer le gas du relayer
  par spam de micro-intents *valides* (qui passent tous les pré-checks). Non traité en V1
  (4 clients connus), mais à nommer comme surface d'attaque.
- **Gestion des secrets** : motiver l'abandon de la mnémonique (secret racine maximal +
  capacité d'usurpation des clients) ; sur Sepolia, keystore Foundry chiffré pour les clés
  de déploiement, `RELAYER_PK` isolé (service long-running, EOA jetable).

### Pistes actées (phases ultérieures, hors Phase 3)

- **Indexeur Ponder** (Phase 5, avec le front) pour les métriques agrégées plutôt qu'un scan
  depuis `START_BLOCK` à chaque chargement — DB *dérivée*, n'enfreint pas « pas de DB ».
- **Hébergement** front + relayer (Phase 6) pour des paiements gasless 24/7 et une démo en URL.
- **Standards de token institutionnels** : ERC-1404 (Simple Restricted Token) et ERC-3643
  (T-REX + ONCHAINID) — **documentés seulement** pour l'instant (choix utilisateur
  2026-06-13) ; pas de refactor des tokens (toucherait des contrats testés + les invariants).

### Limite connue (à gérer côté front en Phase 5)

Le pré-check de nonce du relayer est **séquentiel et synchrone** : un second intent du
**même** client est rejeté en `409 nonce_mismatch` tant que le premier n'est pas miné
(`nonces(from)` n'a pas encore avancé). Pas de paiements en rafale du même payeur. Pour la
démo (4 clients) c'est sans impact ; **le front (Phase 5) doit désactiver le bouton
« payer » jusqu'à confirmation** du paiement précédent du client (cohérent avec le suivi
signé→soumis→confirmé). Une vraie file de nonces côté relayer est une option V2 si besoin.

### Vérification

`forge build` propre, `forge test` **112/112 verts** (95 unitaires + 8 intégration +
5 invariants à 128 runs × 64, 0 revert), `forge fmt --check` propre, relayer `typecheck`
+ `vitest` (16) verts. **E2E local** : `make anvil` → `make deploy-local` (genèse cohérente,
JSON enrichi) → relayer (`/health` vert, boot-check `RELAYER_PK` ↔ déploiement) → smoke
`send-intent` (intent alice1→bob1 signé, posté, miné, `nonces(alice1)==1`, réserves
500 000→499 000 / 501 000, **idempotence OK**) ; rejets vérifiés : signature malformée 400,
schéma 400, nonce périmé 409 ; `make seed` ré-exécuté = « No transactions to broadcast ».

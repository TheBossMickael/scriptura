# Two-Tier Money Sandbox — Récapitulatif complet du projet

> Document de référence consolidant toutes les décisions de design prises en phase de conception.
> Sert de matière première au `CLAUDE.md` qui pilotera l'implémentation via Claude Code.

---

## 1. Vision du projet

**Simulation on-chain complète du système monétaire à deux étages**, déployée sur Sepolia :
monnaie centrale tokenisée (wCBDC), dépôts bancaires tokenisés, et un stablecoin adossé à ces
dépôts — avec règlement interbancaire atomique, scénarios de crise, et un frontend par rôle.

**Ce que le projet démontre :**
- La *singleness of money* : un euro chez la Banque A vaut un euro chez la Banque B *parce que*
  chaque transfert inter-banques de monnaie commerciale est réglé en monnaie centrale, atomiquement.
- La fragilité structurelle des banques (réserves fractionnaires → bank run possible) et le rôle
  du prêteur en dernier ressort (LOLR — Lender Of Last Resort).
- La contagion entre finance traditionnelle et stablecoins (scénario depeg type USDC/SVB 2023).
- Le contraste monnaie intermédiée (DEP, dépendante du relayer et de la banque) vs monnaie
  permissionless (sEUR, qui circule même quand l'infrastructure censure ou tombe).
- Le *paradoxe de transparence* : tout étant public on-chain, les paniques se coordonnent plus vite.

**Référentiel réel :** TARGET2, Project Agorá / unified ledgers (BRI), MiCA (le sEUR est
structurellement un EMT), doctrine Bagehot, Diamond-Dybvig (Nobel 2022).

---

## 2. Concepts métier fondamentaux (acquis)

| Concept | Résumé |
|---|---|
| **M0 / monnaie centrale** | Passif de la banque centrale. Réserves détenues uniquement par les banques. Dette « finale », non remboursable contre autre chose. |
| **M1 / monnaie commerciale** | Passif d'une banque commerciale. Ton solde bancaire = une créance sur ta banque, pas des euros de banque centrale. |
| **Chaîne des créances** | La monnaie de chaque étage est une dette de l'étage au-dessus : Alice → créance sur Banque A → créance sur BC. |
| **Actif / passif** | Passif = ce que tu dois ; actif = ce que tu possèdes. Le bilan est *toujours* équilibré (identité comptable). |
| **Réserves fractionnaires** | La banque détient ~15 % de ses dépôts en réserves ; le reste est prêté (« les crédits font les dépôts »). Hypothèse structurante : sans elle, aucun scénario de crise n'existe. |
| **Solvabilité vs liquidité** | Solvable = actifs ≥ dettes. Liquide = capable de payer *maintenant*. Une banque solvable peut être illiquide (transformation de maturité : emprunter court, prêter long). |
| **Ratio de réserves** | `wCBDC.balanceOf(bank) / DEP.totalSupply()`. Lors d'une sortie, numérateur et dénominateur baissent du même montant absolu → le ratio chute. |
| **Bank run** | Phénomène de coordination (Diamond-Dybvig) : deux équilibres pour le même bilan. Premier arrivé, premier servi → courir devient rationnel si on croit que les autres courent. Pas besoin de baleine, une croyance suffit. |
| **LOLR** | Doctrine Bagehot : prêter largement, contre bon collatéral, à taux de pénalité. Même guichet que le refinancement, paramètres de crise. Sauve les illiquides, laisse mourir les insolvables. |
| **Stablecoin fiat-backed** | sEUR = créance sur StableCo, elle-même créance sur la Banque A. Réserves 100 % en DEP-A : choix délibéré, plus concentré que le plancher MiCA (30/60 % en dépôts bancaires) pour maximiser le canal de contagion. |

---

## 3. Acteurs et articulation

**Principe directeur : l'EOA décide, le contrat contraint, le token comptabilise.**
Les fonds soumis à des règles vivent dans des contrats, jamais sur des EOA. Une EOA ne peut
rien garantir ; un contrat *est* la règle (invariants testables, composition possible, état lisible).

### Binômes institutionnels (EOA opérateur + contrat)
| Acteur | EOA | Contrat | Rôle du contrat |
|---|---|---|---|
| Banque centrale | Opérateur BC (= deployer) | `CentralBank.sol` | Émission wCBDC, allowlist banques, paramètre du ratio ; V2 : refinancement, LOLR, taux |
| Banque A | Opérateur A | `CommercialBank.sol` (instance A) | Détient les réserves wCBDC, registre clients, freeze, possède son DepositToken |
| Banque B | Opérateur B | `CommercialBank.sol` (instance B) | Idem |
| StableCo | Opérateur StableCo | `StableCo.sol` | Vault : détient les DEP-A, mint/redeem le sEUR 1:1, preuve de réserves on-chain |

### Clients (EOA nues, sans contrat — ils ne portent aucune règle)
- Alice1, Alice2 : clientes de la Banque A
- Bob1, Bob2 : clients de la Banque B
- Ils ne signent que des messages off-chain (intents EIP-712, autorisations EIP-3009) + transferts directs de sEUR.

**Total : 8 EOA**, dérivées d'un seul mnémonique HD (indexes 0–7).
Le contrat `StableCo.sol` est **enregistré comme client** de la Banque A (un contrat peut être client).

---

## 4. Contrats et tokens

### Contrats (V1) — 7 fichiers sources, 9 instances déployées
1. `WCBDC.sol` — ERC-20 restreint (allowlist), mint/burn par CentralBank, `SETTLER_ROLE` pour l'engine.
2. `CentralBank.sol` — admin wCBDC, allowlist, ratio réglementaire.
3. `CommercialBank.sol` ×2 — réserves, registre clients (`isClient`), `freeze()/unfreeze()` (Pausable).
4. `DepositToken.sol` ×2 (DEP-A, DEP-B) — ERC-20 « bête » avec restrictions : hook `_update` n'autorise un transfert que si `from` et `to` sont clients de la banque, OU si l'appelant est le SettlementEngine.
5. `SettlementEngine.sol` — cœur du système : vérifie les intents EIP-712 (signature, nonce séquentiel, deadline, clientèle, solde wCBDC), exécute le règlement atomique.
6. `StableCo.sol` — vault de réserves, mint/redeem, compose avec l'engine pour les cas cross-bank.
7. `StableEUR.sol` — ERC-20 permissionless + EIP-3009 (`transferWithAuthorization`, nonces aléatoires).

V2 : + `BondToken.sol` (collatéral) et logique refinancement/LOLR/marché interbancaire.

### Tokens
| Token | Couche | Émetteur | Détenteurs | Decimals |
|---|---|---|---|---|
| wCBDC | M0 | CentralBank | Banques allowlistées uniquement | 6 |
| DEP-A / DEP-B | M1 | Chaque CommercialBank | Clients enregistrés de la banque | 6 |
| sEUR | privé | StableCo | N'importe qui | 6 |
| BondToken (V2) | collatéral | genèse | Banques | 6 |

**Decimals : 6 partout** (style USDC) — un mismatch casserait silencieusement l'égalité burn/règlement/mint.

### Matrice des rôles (AccessControl OpenZeppelin)
- `CentralBank` : `MINTER/BURNER` sur wCBDC. Admin de l'allowlist et du ratio.
- `SettlementEngine` : `BURNER_ROLE` + `MINTER_ROLE` sur DEP-A et DEP-B, `SETTLER_ROLE` sur wCBDC.
- `StableCo.sol` : `MINTER/BURNER` sur sEUR.
- Chaque opérateur EOA : `OPERATOR_ROLE` sur son contrat institutionnel.
- Documenter qui peut changer quoi (gouvernance miniature des unified ledgers).

---

## 5. Mécanismes clés

### 5.1 Règlement interbancaire atomique (le cœur)
Paiement Alice1 (Banque A) → Bob1 (Banque B), trois opérations dans **une seule transaction** :
1. Burn des DEP-A d'Alice (la dette de A envers Alice s'éteint).
2. Transfert wCBDC : réserves de A → réserves de B (règlement en monnaie centrale).
3. Mint de DEP-B vers Bob (B crée une dette envers Bob, couverte par les wCBDC reçus).

Cas intrabancaire (Alice1 → Alice2) : simple transfert de DEP-A, pas de wCBDC, pas de règlement
(l'engine détecte `fromBank == toBank`).

### 5.2 Routage des transactions — la règle en une ligne
**Flux monétaire initié par un client → intent EIP-712 via relayer (gasless). Action institutionnelle → tx directe de l'opérateur.**
- `PaymentIntent { from, fromBank, toBank, to, amount, nonce, deadline }` — nonce **séquentiel** par user dans l'engine, anti-replay + deadline.
- Le relayer paie le gas ; le contrat re-vérifie tout (le check du relayer évite juste le gas gaspillé).
- Exception sEUR : **deux chemins de transfert P2P** — (a) gasless via EIP-3009 (nonces **aléatoires**, fenêtre validAfter/validBefore ; pattern USDC production) ; (b) `transfer()` direct, l'user paie son gas. Le contraste des deux chemins est une démonstration en soi (désintermédiation).
- Deux systèmes de nonces coexistent (séquentiel engine / aléatoire 3009) : normal, standard, à documenter.

### 5.3 Stablecoin : mint/redeem
- La Banque A n'a **aucun rôle** dans l'émission — elle n'est que l'hébergeur du compte de StableCo.
- Mint par un client de A : StableCo tire les DEP-A du client, mint le sEUR. Atomique.
- Mint par un client de B (cas composé) : burn DEP-B → règlement wCBDC B→A → mint DEP-A à StableCo → mint sEUR. Un intent, une tx, cinq mouvements comptables. **Meilleur test d'intégration du projet.**
- Redeem : symétrique, y compris le cas cross-bank (redeem déclenche un règlement).
- **L'opérateur StableCo ne peut PAS mint.** La supply de sEUR est *endogène* : créée uniquement à la réception des réserves (mint et dépôt de DEP = un seul événement atomique, le sEUR naît directement chez l'acheteur), détruite par les redeem. Aucun stock, aucun inventaire, aucun bouton de mint admin — sinon l'invariant de couverture serait violable par design. Contraste documentaire : Circle a un minter privilégié *parce que* ses réserves off-chain sont invisibles au contrat ; ici les réserves sont on-chain → émission 100 % programmatique et trustless. Seuls pouvoirs de l'opérateur : `pause()` (V1), paramètres de frais (V2+).

### 5.4 Contrainte physique vs contrainte réglementaire
- **Hard (physique)** : solde wCBDC insuffisant pour le règlement → revert. Non négociable.
- **Soft (réglementaire)** : ratio sous le seuil → la banque **continue de payer**, mais event
  `ReserveRatioBreached` + alerte BC + bandeau front. Fidèle au réel (le ratio est surveillé,
  pas vérifié par transaction) et rend le bank run graduel et dramatique.

### 5.5 États de santé d'une banque
| État | Condition | Effet |
|---|---|---|
| 🟢 SAIN | ratio ≥ seuil (10 %) | — |
| 🟠 STRESS | ratio < seuil, réserves > 0 | Event émis, alertes, la banque paie toujours |
| 🔴 ILLIQUIDE | réserves < prochain paiement | Revert. Illiquide ≠ insolvable : le bilan reste équilibré. |

### 5.6 Freeze / unfreeze
`Pausable` sur le DepositToken via la CommercialBank. Trois usages : réalisme (SVB, Grèce 2015),
déclencheur du scénario depeg (gel de A → réserves de StableCo bloquées → redeem revert),
démonstration (les DEP gelés vs le sEUR qui circule toujours). Unfreeze = résolution.

### 5.7 Events — règle d'or
**Chaque mouvement monétaire émet un event riche** (`Settled`, `IntrabankTransfer`, `StableMinted`,
`StableRedeemed`, `ReserveRatioBreached`, `BankFrozen`, ...). Le front et toutes les métriques
en dépendent. Sans events, le dashboard est aveugle.

---

## 6. Use cases (V1 sauf mention)

| # | Use case | Initiateur | Chemin | Mouvements |
|---|---|---|---|---|
| 1 | Paiement intrabancaire | Client | Intent → relayer → engine | Transfer DEP |
| 2 | Paiement interbancaire | Client | Intent → relayer → engine | Burn DEP / wCBDC / mint DEP |
| 3 | Mint sEUR (client de A) | Client | Intent → relayer → StableCo | DEP-A → vault, mint sEUR |
| 4 | Mint sEUR (client de B) | Client | Intent → StableCo + engine | Règlement + mint (cas composé) |
| 5 | Redeem sEUR (2 cas) | Client | Intent → StableCo (+ engine) | Inverse de 3/4 |
| 6 | Transfert P2P sEUR | Client | EIP-3009 via relayer OU transfer direct | Transfer sEUR |
| 7 | Obtention de wCBDC | Banque | Genèse (V1) ; refinancement contre collatéral (V2) | Mint wCBDC |
| 8 | Prêt interbancaire (V2) | Banque | Tx directe | wCBDC + dette enregistrée |
| 9 | Paiement banque-à-banque compte propre | Banque | Transfer wCBDC direct | wCBDC |
| 10 | Admin : register/remove client, freeze, ratio | Banque / BC | Tx directe | État |

Hiérarchie de la liquidité (réaliste) : paiements → tension → marché interbancaire → refinancement → LOLR.

---

## 7. Frontend — une vue par rôle

Le front lit l'adresse connectée (wagmi/viem + MetaMask), la résout via `directory.ts` + rôles
on-chain, et rend la vue. **Le masquage front = UX ; la sécurité = `onlyRole` dans les contrats.**

- **Client (Alice1...)** : soldes DEP + sEUR ; formulaire de paiement (annuaire, signature EIP-712, suivi signé → soumis → confirmé, décomposition pédagogique intra/inter) ; mint/redeem sEUR ; P2P sEUR (boutons gasless / direct) ; historique personnel ; santé de SA banque (ratio public — l'info qui déclenchera sa panique).
- **Opérateur banque** : bilan live en deux colonnes (actif : wCBDC, créances ; passif : supply DEP, dettes) + jauge du ratio ; gestion clients (liste / ajouter / retirer) ; freeze/unfreeze ; flux entrants/sortants ; V2 : marché interbancaire, guichet de refinancement.
- **Opérateur StableCo** : preuve de réserves (réserves DEP-A vs supply sEUR, ratio de couverture), volumes mint/redeem, détenteurs. Peu d'actions et **aucun pouvoir de mint** (cf. 5.3) — un émetteur sain est ennuyeux.
- **Banque centrale** : dashboard macro (M0, M1 par banque, agrégats, flux interbancaires) ; allowlist ; paramètre du ratio (macroprudentiel en un slider) ; mur d'alertes `ReserveRatioBreached` ; V2 : console refinancement/LOLR, taux.
- **Observateur (wallet inconnu / non connecté)** : toutes les métriques publiques — démo de la transparence radicale.

---

## 8. Genèse chiffrée (V1)

| Poste | Valeur |
|---|---|
| wCBDC total (M0) | **3 000** — invariant V1 : constant |
| Réserves Banque A / Banque B | 1 500 / 1 500 |
| DEP-A : Alice1 / Alice2 | 6 000 / 4 000 (asymétrie volontaire) |
| DEP-B : Bob1 / Bob2 | 6 000 / 4 000 |
| Ratio initial / seuil réglementaire | 15 % / 10 % |
| Ligne « prêts » au bilan des banques | 8 500 chacune — convention de genèse documentée, non tokenisée |
| StableCo | Démarre à 0 (premier mint en live = meilleure démo) |
| sETH | Relayer : approvisionné + alerte de solde ; opérateurs : ~0,05 ; clients : ~0,02 (pour le P2P sEUR direct) |

Le script de genèse (Foundry) doit produire un état **comptablement cohérent** et reproductible.

---

## 9. Invariants (tests Foundry, dont invariant testing)

1. `totalSupply(wCBDC) == 3 000` constant (V1) ; V2 : `ΔM0 == refinancements nets`.
2. Tout transfert inter-banques de M1 s'accompagne d'un mouvement wCBDC strictement égal, dans la même transaction.
3. `totalSupply(sEUR) <= DEP.balanceOf(StableCo)` (couverture 100 %).
4. Seules les adresses allowlistées détiennent de la wCBDC.
5. Seuls les clients enregistrés détiennent des DEP de leur banque.
6. Nonces : pas de replay possible (séquentiels engine, aléatoires 3009) ; deadlines respectées.
7. Conservation : un paiement ne crée ni ne détruit de valeur agrégée (somme des bilans).

---

## 10. Stack technique et décisions d'infra

| Domaine | Choix | Pourquoi |
|---|---|---|
| Smart contracts | Solidity, **Foundry**, OpenZeppelin v5 (AccessControl, Pausable, EIP-712, Nonces) | Standard pro ; invariant testing natif |
| Chaîne | **Sepolia** (démo) + **Anvil** local (dev quotidien) | Dev instantané en local, déploiement one-shot testnet |
| Relayer/back | **Node.js + viem**, un seul endpoint `POST /intent` | Auto-authentifiant (la signature EIP-712 EST l'auth) |
| Front | **React + wagmi/viem**, annuaire `directory.ts` généré au déploiement | Vue par rôle, lecture directe de la chain |
| Persistance | **Aucune DB.** Chain = source de vérité ; back stateless | Tout état rederivable de la chain ou de la config |
| Auth | **Le wallet est l'authentification** (rôles on-chain). SIWE écarté en V1 (un seul endpoint, auto-authentifié), **introduit en V2** (cf. roadmap) | Pas de sessions, pas de table users |
| Orchestration | **Docker Compose** (front + relayer) + **Makefile** | `anvil`, `deploy-local`, `deploy-sepolia`, `seed`, `up`, `down`, `fund-check` |
| Vérification | `forge verify-contract` sur Etherscan | Transparence ; lecture publique pendant les démos |

### Cycle de vie / redémarrages (`make down` → `make up`)
- L'état vital est on-chain : soldes, registres, nonces, ratios, historique. Le laptop peut s'éteindre.
- Survit dans le repo : `deployments/sepolia.json` (adresses, commité), `START_BLOCK` (scan d'events), `.env.example`.
- Survit hors repo : `.env` (clés, RPC).
- Au boot du relayer : relire `engine.nonces(user)` on-chain + **resynchroniser le nonce pending de sa propre EOA** (piège des tx en vol).
- Cache d'idempotence du relayer : en mémoire, jetable sans gravité.
- Redéployer (pour la V2) = nouveau `deployments.json` + re-seed. Non destructif, et test de reproductibilité de la genèse.

### Risque opérationnel assumé
Le relayer est un **point de défaillance unique** (parallèle direct avec le relayer unique de
l'architecture BdF du stage, et avec les pannes TARGET2 — oct. 2020, 10 h d'interruption).
Assumé en V1, et exploité comme scénario (censure/panne).

---

## 11. Roadmap

### V1 — Le cœur (cible Claude Code, par phases)
4 tokens, 7 contrats, règlement atomique, intents EIP-712 + EIP-3009, relayer gasless, genèse,
front 5 vues, events exhaustifs, états de santé, freeze, tests unitaires + invariants, docs.
Phases d'implémentation : (1) wCBDC + allowlist + tests → (2) banques + DEP + registre + engine →
(3) intents + relayer → (4) StableCo + sEUR + 3009 → (5) front → (6) docs + scripts.

### V2 — Crise et liquidité
- Scénarios orchestrés par agents off-chain : **bank run** (règle : « si ratio de ma banque < X %, je fuis » → cascade), **depeg** (freeze de A → redeem revert → couverture < 100 %), **censure/panne du relayer** (DEP morts, sEUR vivant).
- Marché interbancaire (prêt de wCBDC, taux, échéance).
- Refinancement (`BondToken`, décote 10 %, taux 2 %) + **LOLR** (décote 30 %, taux 5 % = pénalité Bagehot).
- **SIWE (EIP-4361)** : le back expose des endpoints privilégiés de pilotage des scénarios (`POST /scenario/bank-run`, `POST /scenario/depeg`, pause du relayer...) protégés par Sign-In With Ethereum — déclencher une crise est réservé aux opérateurs autorisés, identifiés par signature de challenge avec leur wallet.
- M0 dynamique → invariant raffiné. Redéploiement Sepolia assumé.

### V3 — Marché et politique
- AMM sEUR/DEP → un **prix de marché** émerge → vrai depeg observable (et lien avec l'AMM du stage).
- Rémunération des réserves (politique monétaire par les taux, arbitrage des agents).
- Création monétaire par le crédit (« les crédits font les dépôts ») : la ligne « prêts » devient réelle.

### V4 — Multi-chain (horizon lointain, lien direct avec le stage)
- L1 = banque centrale / règlement ; un rollup par banque commerciale.
- Le règlement cross-chain réutilise l'architecture **HTLC + intents** du stage BdF.
- C'est l'esprit Appia / unified ledger : le projet rejoint le sujet de stage.

---

## 12. Livrables documentation

- `README.md` — quickstart, démos.
- `docs/monetary-design.md` — le « pourquoi » : deux étages, créances, choix 100 % réserves (vs plancher MiCA), **paradoxe de transparence**, clin d'œil EMT/MiCA/ACPR, qui-opère-le-ledger (question Agorá non tranchée que le code tranche).
- `docs/architecture.md` — contrats, rôles, routage intents/3009, séquences.
- `docs/scenarios.md` — déroulé chiffré de chaque scénario.
- `docs/threat-model.md` — matrice des rôles, qui peut mint quoi, invariants, surfaces d'attaque (replay, relayer, fire-sale métaphorique).

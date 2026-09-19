# Planifier un achat ENS avec Temporal

> **Audience :** implémenter un watch « achète ce `.eth` dès qu’il rentre dans le budget », sans casser l’hexagone ni `purchase_ens`.
> **Loi :** [HEXAGONAL.md](./HEXAGONAL.md), [SECURITY.md](./SECURITY.md), [ENS_PURCHASE.md](./ENS_PURCHASE.md).
> **Prérequis :** `PurchaseEnsName` + `ViemEnsRegistrarAdapter` déjà en place. Node 20+, pnpm, Docker **ou** le [Temporal CLI](https://docs.temporal.io/cli).
> **Ce que ça ne fait pas :** livrer le NFT à l’utilisateur. Comme aujourd’hui, le owner est l’EOA de l’agent.

Ce document est un **tutoriel d’implémentation**, pas le code déjà mergé. Suis les phases dans l’ordre : un port registrar cassé trop tard, et le workflow Temporal n’a plus rien d’honnête à appeler.

---

## Vue d’ensemble (à lire avant tout le code)

### Le problème, en une histoire

Un utilisateur veut `dayan.eth`. Le nom est pris : il expire le **13 juin 2026** et n’est enregistrable par un tiers qu’à la fin de la période de grâce, le **11 septembre 2026**. Sauf qu’à cette seconde-là il n’est pas achetable pour autant : ENS le met aux enchères hollandaises pendant **21 jours**, prime de départ ~100 M$, qui décroît jusqu’à zéro.

Il faut donc un objet qui **dort six mois**, se réveille avant le drop, **surveille le prix** pendant trois semaines, et achète en **deux transactions** dès que le montant passe sous `ENS_MAX_PURCHASE_ETH`.

Un `setTimeout` ne tient pas : il meurt au prochain `pnpm start`. Un `cron` qui poll The Graph toutes les minutes pendant six mois est absurde, et surtout il ne sait pas se souvenir du **secret du commit** entre les deux transactions. C’est exactement le trou que Temporal remplit : des **timers durables** et un **historique** qui survit au crash du process.

### Les deux horloges à ne pas confondre

C’est la source d’erreur numéro un de cette feature.

| Horloge | Durée | Qui l’impose | Ce qu’elle contraint |
|---|---|---|---|
| **Drop ENS** | grâce = expiry + 90 j, puis prime sur 21 j | `BaseRegistrar` + `ETHRegistrarController` | *Quand* le nom devient achetable dans le budget |
| **Commit-reveal** | `MIN_COMMITMENT_AGE` ≈ 60 s, `MAX_COMMITMENT_AGE` = 24 h | `ETHRegistrarController` | L’écart autorisé entre `commit` et `register` |

Le réveil anticipé du workflow (quelques heures avant la fin de grâce) sert **uniquement** à commencer à surveiller le prix. Le `commit`, lui, n’est envoyé **qu’une fois le prix dans le budget**, parce qu’il ouvre une fenêtre de 24 h seulement. Committer six mois à l’avance ne sert à rien : la fenêtre serait périmée.

### La frise temporelle d’un watch

```text
  création          graceEnd − marge      graceEnd            graceEnd + 21 j
  (Telegram)        (réveil)              (available = true)  (prime ≈ 0)
      │                    │                    │                    │
      │   sleep durable    │   poll 30 s        │   poll 30 s        │
      │   (jusqu'à 6 mois) │                    │                    │
      ▼                    ▼                    ▼                    ▼
 ┌───────────┐       ┌──────────┐        ┌──────────────────────────────┐
 │ scheduled │──────▶│  arming  │───────▶│           buying             │
 └───────────┘       └──────────┘        └──────────────────────────────┘
                     available: false     available: true
                     prix: n/a            prix: 100 M$ ──────────▶ budget
                                                                    │
                                          commit ──60 s──▶ register ┘
```

Le `commit` et le `register` tombent **à la fin**, quand la courbe de prime croise ton plafond. Pas au moment du `graceEnd`.

### Qui appelle qui, à l’exécution

Deux process Node, un serveur Temporal au milieu. Le numéro indique l’ordre.

```text
 1  Telegram                 « surveille dayan.eth pendant 1 an »
                                        │
    ┌───────────────────────────────────┼──── process bot : pnpm start:dev ────┐
 2  │ createEnsScheduleTool  ──▶  ScheduleEnsPurchase  ──▶  EnsWatchSchedulerPort
 3  │ TemporalWatchSchedulerAdapter  ──▶  client.workflow.start('ens-drop:dayan')
    └───────────────────────────────────┼───────────────────────────────────────┘
                                        ▼
 4  ┌──────────────────────────────────────────────────────────────────────────┐
    │  Temporal Server  127.0.0.1:7233                                         │
    │  historique d'événements · timers durables · task queue « ens-drop »     │
    └──────────────────────────────────────────────────────────────────────────┘
              │  tâche workflow                     ▲  commandes (sleep, activity)
              ▼                                     │
    ┌───────────────────────────────────┼──── process worker : pnpm start:worker ┐
 5  │ Worker  ──▶  isolate V8 : watchEnsDrop(input)     ← ni Nest, ni viem ici
 6  │ sleep(6 mois)                   le timer vit côté serveur, pas côté Node
 7  │ refreshQuote()   ──▶ activity ──▶ PurchaseEnsName.quote + EnsLookupPort
 8  │ commitName()     ──▶ activity ──▶ EnsRegistrarPort.commit    ──▶ tx 1
 9  │ sleep(62 s)
10  │ registerName()   ──▶ activity ──▶ EnsRegistrarPort.register  ──▶ tx 2
11  │ notifyChat()     ──▶ activity ──▶ OutboundMessagingPort      ──▶ Telegram
    └──────────────────────────────────────────────────────────────────────────┘
```

Le point mental important : **le workflow ne fait aucune I/O**. Il décide, il dort, il demande. Toute sortie vers le monde passe par une activity, donc par tes ports existants.

### Les fonctions du workflow, et leurs branches

```text
watchEnsDrop(input)                                    ← workflows/watchEnsDrop.workflow.ts
│
├─ setHandler(cancelWatchSignal)      ← signal externe, recevable à tout instant
│
├─ sleep(jusqu'à graceEnd − marge)
│      └─ annulé ? ──▶ notifyChat()  ──▶ throw CANCELLED
│
├─ refreshQuote()
│      └─ gracePeriodEnd repoussé ? ──▶ notifyChat() ──▶ return  (le owner a renew)
│
├─ while (!available || !withinBudget)          ← la prime décroît sur 21 jours
│      ├─ annulé ? ──▶ notifyChat() ──▶ throw CANCELLED
│      ├─ sleep(30 s)
│      └─ refreshQuote()
│             └─ renew détecté ? ──▶ notifyChat() ──▶ return
│
├─ commitName()                       ── tx 1 ──▶  à partir d'ici le gas est dépensé
│
├─ sleep(MIN_COMMITMENT_AGE + 2 s)
│
├─ refreshQuote()
│      └─ sorti du budget ? ──▶ re-poll puis recommit  (durcissement, §6.3)
│
├─ registerName()                     ── tx 2 ──▶  payable, maximumAttempts: 1
│
└─ notifyChat()                       ──▶ Telegram : hash de la transaction
```

Chaque flèche `notifyChat()` est un chemin de sortie **observable par l’utilisateur**. Un watch qui meurt en silence est un bug produit, pas seulement technique.

### Carte des fichiers

« Une page » du tutoriel = un fichier à écrire. Voici le plan complet, avec la section qui le détaille.

| Fichier | Couche | Rôle | Section |
|---|---|---|---|
| `app/ports/ens/EnsRegistrarPort.ts` | app | Ajoute `commit` / `register` / `minCommitmentAgeSeconds` | [§4](#4-phase-1--casser-ensregistrarport-sans-temporal) |
| `infrastructure/adapters/ens/ViemEnsRegistrarAdapter.ts` | infra | Implémente le split, garde le mutex EOA | [§4](#4-phase-1--casser-ensregistrarport-sans-temporal) |
| `domain/ens/EnsDropWatch.ts` | domain | États et transitions pures du watch | [§5.1](#51-ensdropwatch-pur) |
| `app/ports/watch/EnsWatchSchedulerPort.ts` | app | Contrat `start` / `cancel` / `describe` | [§5.2](#52-use-cases) |
| `app/use-cases/EnsWatch/*.ts` | app | Autorise et crée le watch, l’annule | [§5.2](#52-use-cases) |
| `infrastructure/adapters/temporal/workflows/watchEnsDrop.types.ts` | infra | Payload du workflow, **sans secret** | [§6.1](#61-contrat-dentrée-payload-historique) |
| `infrastructure/adapters/temporal/activities/ensDrop.activities.ts` | infra | 4 wrappers fins vers les use cases | [§6.2](#62-activities--signatures) |
| `infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.ts` | infra | L’orchestration durable (isolate) | [§6.3](#63-le-workflow-isolate) |
| `infrastructure/adapters/temporal/TemporalWatchSchedulerAdapter.ts` | infra | Implémente le port via le Client | [§6.4](#64-adapter-client) |
| `infrastructure/adapters/temporal/temporal.config.ts` | infra | Lit les `TEMPORAL_*` | [§7.1](#71-temporalconfigts) |
| `bootstrap/BotModule.ts` | bootstrap | Client Temporal côté bot | [§7.2](#72-client-bot--botmodule) |
| `bootstrap/WorkerModule.ts` | bootstrap | `Worker.create` + activities bindées | [§7.3](#73-worker--workermodule--workerts) |
| `bootstrap/worker.ts` | bootstrap | Entrypoint du second process | [§7.3](#73-worker--workermodule--workerts) |
| `infrastructure/adapters/langgraph/tools/createEnsScheduleTool.ts` | infra | L’outil exposé au LLM | [§8](#8-phase-5--outil-langgraph-schedule_ens) |

Tous les chemins sont relatifs à `agents/src/`.

### Ce que Temporal ne décide pas

Pour garder l’hexagone droit, retiens la répartition suivante. Temporal apporte le **temps** ; ton code garde le **sens**.

| Question | Qui répond |
|---|---|
| Ce chat peut-il dépenser les fonds ? | `ScheduleEnsPurchase` (use case) |
| Ce label est-il valide, cette durée légale ? | `EnsPurchasePolicy` (domain) |
| Ce prix est-il dans le budget ? | `EnsPurchasePolicy` / `PurchaseEnsName` |
| Comment signer un `commit` ? | `ViemEnsRegistrarAdapter` (infra) |
| Quand se réveiller, comment survivre à un crash | **Temporal** |
| Combien de fois retenter, quoi ne jamais retenter | **Temporal** (RetryPolicy) + taxonomie du port |

---

## 0. Décisions figées (ne pas les rediscuter dans le code)

| Décision | Valeur | Pourquoi |
|---|---|---|
| Politique de trigger | **B** : `available && rentPrice ≤ budget` | Au jour de fin de grâce, la prime ENS vaut ~100 M$. `available()` ≠ achetable. |
| Un watch par label | `workflowId = ens-drop:{label}` | Une EOA, un nonce. Deux watches sur `dayan.eth` = collision. |
| Plafond | snapshot de `ENS_MAX_PURCHASE_ETH` **à la création** | Changer le `.env` plus tard ne doit pas surprendre un workflow endormi 6 mois. |
| Owner du nom | EOA agent | Identique à `buy()`. Un transfert est un autre use case. |
| LLM | démarre / annule / liste. **Il n’achète pas dans 6 mois.** | `MemorySaver` LangGraph meurt au restart. Temporal survit. |

Si tu vises « le premier bloc `available()` », arrête-toi : avec `ENS_MAX_PURCHASE_ETH=0.02` ça échouera toujours.

---

## 1. Ce que Temporal est (et n’est pas)

Temporal = **serveur + historique + timers durables**. Ton process Nest peut crasher entre `commit` et `register` : le workflow se reprend.

```text
Telegram  →  Nest bot (Client Temporal)  →  Temporal Server
                                              │  task queue "ens-drop"
                                              ▼
                                         Nest worker
                                         activities → tes use cases / viem
```

Deux process Node, **un même graphe DI** :

| Process | Entrée | Rôle |
|---|---|---|
| Bot | `src/bootstrap/bot.ts` (existant) | Telegram, LLM, `client.workflow.start` |
| Worker | `src/bootstrap/worker.ts` (nouveau) | Poll la task queue, exécute workflows + activities |

Le **workflow** tourne dans un **isolate V8** : pas de Nest, pas de viem, pas de `fs`, pas de `Date.now()` non déterministe (utilise `workflow.sleep` / `workflow.now()`). Il ne fait que : dormir, appeler des activities, brancher.

Les **activities** sont du TypeScript normal. C’est là que tu injectes `PurchaseEnsName` et le registrar.

Ne mets **jamais** `AGENT_PRIVATE_KEY` dans les arguments du workflow : l’historique Temporal les persiste.

---

## 2. Configuration : serveur local

### 2.1 Option A — Temporal CLI (recommandé en local)

Sur Fedora / Linux :

```bash
curl -sSf https://temporal.download/cli.sh | sh
```

L’installeur pose le binaire dans `~/.temporalio/bin` **sans toucher au PATH**. Sans cette étape, la commande suivante répond `temporal : commande non trouvée` :

```bash
echo 'export PATH="$PATH:$HOME/.temporalio/bin"' >> ~/.bashrc
source ~/.bashrc      # uniquement pour le shell courant
temporal --version    # temporal version 1.8.3 (Server 1.31.2, UI 2.50.1)
```

Ne lance pas le script avec `sudo` : le binaire appartiendrait à `root` et la prochaine mise à jour échouerait en écriture. Si c’est déjà le cas, `sudo chown "$USER":"$USER" ~/.temporalio/bin/temporal`.

Puis, dans un terminal que tu laisses ouvert :

```bash
temporal server start-dev --db-filename /tmp/temporal.db
```

Ça lève :

- gRPC **`127.0.0.1:7233`** — SDK
- UI **`http://127.0.0.1:8233`** — historique des workflows

Ctrl+C arrête le serveur ; `--db-filename` garde l’état entre deux runs.

### 2.2 Option B — Docker (si tu ne veux pas le CLI)

```bash
docker run --rm -p 7233:7233 -p 8233:8233 temporalio/auto-setup:1.28
```

L’image `auto-setup` embarque Cassandra + UI. Plus lourd, suffisant. Ne l’utilise pas en prod.

### 2.3 Vérifier

```bash
temporal operator cluster health --address 127.0.0.1:7233
# SERVING
```

`SERVING` est le statut standard du health check gRPC. Si tu obtiens `connection refused`, le serveur du terminal précédent n’est pas lancé.

Ouvre `http://127.0.0.1:8233` : namespace `default`, task queues vides.

---

## 3. Configuration : projet `agents/`

### 3.1 Dépendances

Depuis `agents/` :

```bash
pnpm add @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity
pnpm add -D @temporalio/testing
```

| Package | Qui l’importe |
|---|---|
| `@temporalio/client` | bot (`ScheduleEnsPurchase` adapter) |
| `@temporalio/worker` | `worker.ts` seulement |
| `@temporalio/workflow` | fichiers **workflow uniquement** |
| `@temporalio/activity` | activities (heartbeat, `ApplicationFailure`) |
| `@temporalio/testing` | tests time-skipping |

Le workflow isolate bundlera `@temporalio/workflow`. S’il importe `@temporalio/worker` ou `viem`, le worker refuse de démarrer. **Règle durcie :** `src/infrastructure/adapters/temporal/workflows/` n’importe que `@temporalio/workflow` et des **types**.

### 3.2 Variables d’environnement

**Fichiers : `agents/.env` et `agents/.env.example`**

```bash
# Temporal — local default. Cloud: set TEMPORAL_NAMESPACE + TEMPORAL_API_KEY + TLS.
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=ens-drop
# TEMPORAL_TLS=true
# TEMPORAL_API_KEY=
# TEMPORAL_CLIENT_CERT_PATH=
# TEMPORAL_CLIENT_KEY_PATH=
```

En local tu n’as besoin que des trois premières. Cloud : namespace du type `quickstart-foo.bar`, `TEMPORAL_ADDRESS=eu-central-1.aws.api.temporal.io:7233` (région réelle = celle de ton compte), API key, TLS on.

### 3.3 Scripts `package.json`

**Fichier : `agents/package.json`**

```json
{
  "scripts": {
    "start:dev": "nest start --watch",
    "start:worker": "nest start --entryFile bootstrap/worker --watch",
    "start:worker:prod": "node dist/bootstrap/worker.js"
  }
}
```

`nest-cli.json` a déjà `"entryFile": "bootstrap/bot"`. Le worker passe un autre entry via `--entryFile` ; le build Nest compile tout `src/`, donc `dist/bootstrap/worker.js` existe après `pnpm build`.

### 3.4 Arborescence cible

```text
agents/src/
  domain/ens/
    EnsDropWatch.ts                        # état + transitions pures        §5.1
  app/ports/ens/
    EnsRegistrarPort.ts                    # + commit / register            §4
  app/ports/watch/
    EnsWatchSchedulerPort.ts               # start / cancel / describe      §5.2
  app/use-cases/EnsWatch/
    ScheduleEnsPurchase.ts                 #                                §5.2
    CancelEnsWatch.ts                      #                                §5.2
  infrastructure/adapters/ens/
    ViemEnsRegistrarAdapter.ts             # implémente le split            §4
  infrastructure/adapters/langgraph/tools/
    createEnsScheduleTool.ts               # outil LLM                      §8
  infrastructure/adapters/temporal/
    workflows/
      watchEnsDrop.types.ts                # payload, sans secret           §6.1
      watchEnsDrop.workflow.ts             # isolate — ni Nest ni viem      §6.3
      watchEnsDrop.workflow.spec.ts        # time skipping                  §9.2
    activities/
      ensDrop.activities.ts                # 4 wrappers fins                §6.2
    TemporalWatchSchedulerAdapter.ts       # implémente le port via Client  §6.4
    temporal.config.ts                     # lit les TEMPORAL_*             §7.1
  bootstrap/
    main.ts                                # bot (existant)
    BotModule.ts                           # + Client Temporal              §7.2
    worker.ts                              # entrypoint worker              §7.3
    WorkerModule.ts                        # Worker.create + activities     §7.3
```

Temporal vit sous `adapters/`, comme `telegram`, `langgraph` ou `thegraph` : c’est un vendor, pas une couche. Le dossier contient d’ailleurs les **deux sens** de l’hexagone, ce qui est normal pour un SDK qui va dans les deux directions.

| Fichier | Sens | Équivalent existant |
|---|---|---|
| `TemporalWatchSchedulerAdapter.ts` | **driven** (app → monde) | `TheGraphEnsAdapter` |
| `activities/` + `WorkerModule` | **driving** (monde → app) | `TelegramInboundAdapter`, un `@Cron` |
| `workflows/` | ni l’un ni l’autre : orchestration pure | — |

Le workflow est le cas particulier : il n’appelle aucun use case directement et ne traduit aucun SDK. Il décide *quand*, et ce sont les activities — de vrais adaptateurs driving — qui entrent dans `app/`.

---

## 4. Phase 1 — Casser `EnsRegistrarPort` (sans Temporal)

`buy()` fait commit + sleep process + register. Un watch a besoin des deux txs **à des heures différentes**, et le sleep process **ne survit pas**.

Étends le port, **ne remplace pas** `buy()` (l’achat immédiat Telegram continue de l’utiliser).

**Fichier : `agents/src/app/ports/ens/EnsRegistrarPort.ts`**

```ts
export type EnsCommitmentInput = {
  label: string;
  durationSeconds: number;
  /** Reuse a secret to make a retried commit idempotent. */
  secret?: string;
};

export type EnsCommitment = {
  label: string;
  durationSeconds: number;
  secret: string;          // Hex 0x… — JAMAIS loggé, JAMAIS renvoyé au LLM
  commitment: string;      // hash on-chain
  commitmentTransactionHash: string;
};

export type EnsRegistrationFromCommitment = EnsRegistrationInput & {
  secret: string;
  commitmentTransactionHash: string;
};

export interface EnsRegistrarPort {
  quote(input: Omit<EnsRegistrationInput, 'maxTotalCostWei'>): Promise<EnsRegistrationQuote>;
  buy(input: EnsRegistrationInput): Promise<EnsRegistrationReceipt>;

  /** Does not require available(). */
  commit(input: EnsCommitmentInput): Promise<EnsCommitment>;

  register(input: EnsRegistrationFromCommitment): Promise<EnsRegistrationReceipt>;

  minCommitmentAgeSeconds(): Promise<number>;
}
```

Le `secret?` optionnel est ce qui rend un retry de `commitName` sans danger : régénérer un secret minerait un second commitment et brûlerait du gas pour rien. Le workflow fournira un secret stable.

Puis, dans **`agents/src/infrastructure/adapters/ens/ViemEnsRegistrarAdapter.ts`** :

- `commit` : `makeCommitment` + `commit`, **sans** `assertPurchasable`. Le controller ENS n’exige pas `available()` pour committer, et c’est tout l’intérêt.
- `register` : re-quote, `assertPurchasable`, **`assertFunded`** (le commit peut avoir des heures, le solde a pu bouger), puis `register` payable. Toute défaillance ressort en `REGISTRATION_FAILED` avec le hash du commit.
- `buy()` devient la **composition** des deux : pré-check, `commit`, attente, `register`. Sinon la séquence commit-reveal existe en double et les deux copies divergeront.
- Le mutex `this.operation` couvre les trois entrées. Attention : les méthodes publiques prennent le verrou, donc `buy` doit appeler des variantes privées `*Exclusive` — appeler le `commit()` public depuis `buyExclusive` s’enfile derrière soi-même et **deadlock**.

`quote()` doit déjà renvoyer `available: false` + un `premiumWei` énorme plutôt que throw. Vérifie-le : le workflow en a besoin **avant** le drop.

Tests : étendre le fake `EnsChainDriver` ; un test « commit pendant que `available() === false`, register après ».

`MAX_COMMITMENT_AGE` du controller mainnet vaut **24 h**. Le workflow ne doit pas committer 6 mois à l’avance.

---

## 5. Phase 2 — Domaine + use cases (toujours sans Temporal)

### 5.1 `EnsDropWatch` (pur)

**Fichier : `agents/src/domain/ens/EnsDropWatch.ts`**

```ts
export type EnsDropWatchStatus =
  | 'scheduled'
  | 'arming'
  | 'committed'
  | 'buying'
  | 'bought'
  | 'cancelled'
  | 'expired'   // owner a renew
  | 'failed';

export type EnsDropWatch = {
  label: string;
  name: string;
  years: number;
  requesterChatId: string;
  maxWei: string;
  gracePeriodEndUnix: number; // snapshot, re-validé avant commit
};
```

Règles pures à mettre dans une petite policy :

- même `EnsPurchasePolicy.validate` que l’achat immédiat ;
- `assertCanArm(nowUnix, gracePeriodEndUnix)` : on n’entre en `arming` que si `gracePeriodEndUnix - nowUnix ≤ 23 * 3600` (marge sous les 24 h de validité du commit) **ou** si `available && withinBudget` déjà vrai ;
- si un refresh d’expiry montre `gracePeriodEndUnix` **plus loin** que le snapshot → `expired` (renew).

Pas de `Date.now()` dans le domaine : passe `nowUnix` en argument.

### 5.2 Use cases

`ScheduleEnsPurchase.execute({ label, years, chatId })` :

1. `policy.validate` ;
2. allowlist chat (réutilise la même Set que l’outil d’achat, **pas** le LLM) ;
3. lookup / registrar `quote` pour lire `gracePeriodEnd` (via lookup existant : `gracePeriodEndDate`) ;
4. si déjà `available && withinBudget` → oriente vers `PurchaseEnsName.execute` (pas la peine de Temporal) ;
5. `scheduler.start(watch)`.

`CancelEnsWatch.execute({ label, chatId })` : vérifie que le chat est le requester, `scheduler.cancel`.

Ces use cases vivent dans **`agents/src/app/use-cases/EnsWatch/`** et parlent au **port**, pas à `@temporalio/client`.

**Fichier : `agents/src/app/ports/watch/EnsWatchSchedulerPort.ts`**

```ts
export const ENS_WATCH_SCHEDULER_PORT = Symbol('EnsWatchSchedulerPort');

export interface EnsWatchSchedulerPort {
  start(watch: EnsDropWatch): Promise<{ workflowId: string }>;
  cancel(workflowId: string): Promise<void>;
  describe(workflowId: string): Promise<{ status: string }>;
}

export function workflowIdFor(label: string): string {
  return `ens-drop:${label}`;
}
```

---

## 6. Phase 3 — Workflow Temporal

### 6.1 Contrat d’entrée (payload historique)

Petit, public, **sans secret**.

**Fichier : `agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.types.ts`**

```ts
export type WatchEnsDropInput = {
  label: string;
  years: number;
  durationSeconds: number;
  requesterChatId: string;
  maxWei: string;
  gracePeriodEndUnix: number;
};
```

Le `secret` du commit est un **retour d’activity**, stocké dans l’état du workflow (chiffré at-rest par Temporal Server / Cloud). Il ne retraverse pas Telegram.

### 6.2 Activities — signatures

Des **fonctions**, pas une classe, pour que `proxyActivities<typeof activities>` puisse typer. Nest bindera les méthodes dans `WorkerModule` (voir §7).

**Fichier : `agents/src/infrastructure/adapters/temporal/activities/ensDrop.activities.ts`**

```ts
export type QuoteView = {
  available: boolean;
  withinBudget: boolean;
  totalWei: string;
  premiumWei: string;
  gracePeriodEndUnix: number;
};

export async function refreshQuote(input: {
  label: string;
  durationSeconds: number;
  maxWei: string;
}): Promise<QuoteView> { /* bound in worker */ }

export async function commitName(input: {
  label: string;
  durationSeconds: number;
}): Promise<{ secret: string; commitmentTransactionHash: string }> { /* */ }

export async function registerName(input: {
  label: string;
  durationSeconds: number;
  maxWei: string;
  secret: string;
  commitmentTransactionHash: string;
}): Promise<{ registrationTransactionHash: string; totalPaidWei: string }> { /* */ }

export async function notifyChat(input: {
  chatId: string;
  message: string;
}): Promise<void> { /* OutboundMessagingPort */ }
```

Implémentation réelle : `refreshQuote` appelle `PurchaseEnsName.quote` + parse `gracePeriodEndDate` via `EnsLookupPort` (l’expiry peut bouger). `commitName` / `registerName` appellent le registrar étendu. Toute `EnsPurchaseError` / `EnsRegistrationError` non retryable devient, **dans le même fichier** :

```ts
import { ApplicationFailure } from '@temporalio/activity';

throw ApplicationFailure.nonRetryable(error.message, error.code ?? error.failure);
```

`CHAIN_UNAVAILABLE` → **retryable** (laisse la RetryPolicy de l’activity faire).

`registerName` : **`maximumAttempts: 1`**. Un retry après un timeout ambigu double-spend ou casse le nonce.

### 6.3 Le workflow (isolate)

**Fichier : `agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.ts`**

```ts
import {
  proxyActivities,
  sleep,
  defineSignal,
  setHandler,
  condition,
  ApplicationFailure,
} from '@temporalio/workflow';
import type * as activities from '../activities/ensDrop.activities.js';
import type { WatchEnsDropInput } from './watchEnsDrop.types.js';

export const cancelWatchSignal = defineSignal('cancelWatch');

const quoteActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      'INVALID_REQUEST',
      'OVER_BUDGET',
      'INSUFFICIENT_FUNDS',
      'NAME_UNAVAILABLE',
    ],
  },
});

const commitActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '5s' },
});

const registerActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 1 },
});

const notifyActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '20 seconds',
  retry: { maximumAttempts: 5 },
});

/** Marge de réveil avant la fin de grâce : on veut juste être là pour poller. */
const WAKE_UP_BEFORE_DROP_MS = 23 * 60 * 60 * 1000;
const POLL_MS = 30_000;

export async function watchEnsDrop(input: WatchEnsDropInput): Promise<void> {
  let cancelled = false;
  setHandler(cancelWatchSignal, () => {
    cancelled = true;
  });

  const abortIfCancelled = async (message: string) => {
    if (!cancelled) return;
    await notifyActs.notifyChat({
      chatId: input.requesterChatId,
      message,
    });
    throw ApplicationFailure.nonRetryable('Watch cancelled', 'CANCELLED');
  };

  // --- long durable sleep: wake up shortly before the drop, just to poll ---
  const armAtMs = input.gracePeriodEndUnix * 1000 - WAKE_UP_BEFORE_DROP_MS;
  const delay = armAtMs - Date.now(); // Date.now is patched by Temporal in workflows
  if (delay > 0) {
    await Promise.race([
      sleep(delay),
      condition(() => cancelled),
    ]);
    await abortIfCancelled(`Cancelled watch on ${input.label}.eth`);
  }

  // --- arming: wait until purchasable or until we must commit ---
  let quote = await quoteActs.refreshQuote({
    label: input.label,
    durationSeconds: input.durationSeconds,
    maxWei: input.maxWei,
  });

  if (quote.gracePeriodEndUnix > input.gracePeriodEndUnix) {
    await notifyActs.notifyChat({
      chatId: input.requesterChatId,
      message: `${input.label}.eth was renewed. Watch expired.`,
    });
    return;
  }

  while (!quote.available || !quote.withinBudget) {
    await abortIfCancelled(`Cancelled watch on ${input.label}.eth`);
    await sleep(POLL_MS);
    quote = await quoteActs.refreshQuote({
      label: input.label,
      durationSeconds: input.durationSeconds,
      maxWei: input.maxWei,
    });
    if (quote.gracePeriodEndUnix > input.gracePeriodEndUnix) {
      await notifyActs.notifyChat({
        chatId: input.requesterChatId,
        message: `${input.label}.eth was renewed. Watch expired.`,
      });
      return;
    }
  }

  const commitment = await commitActs.commitName({
    label: input.label,
    durationSeconds: input.durationSeconds,
  });

  const minAge = 62; // seconds; or add getMinCommitmentAge activity
  await sleep(minAge * 1000);

  quote = await quoteActs.refreshQuote({
    label: input.label,
    durationSeconds: input.durationSeconds,
    maxWei: input.maxWei,
  });
  if (!quote.available || !quote.withinBudget) {
    // commitment still valid ~23h — keep polling, recommit if this loop would exceed MAX_COMMITMENT_AGE
    throw ApplicationFailure.nonRetryable(
      'Name left budget or availability after commit',
      'COMMITTED_NOT_REGISTERED',
    );
  }

  const receipt = await registerActs.registerName({
    label: input.label,
    durationSeconds: input.durationSeconds,
    maxWei: input.maxWei,
    secret: commitment.secret,
    commitmentTransactionHash: commitment.commitmentTransactionHash,
  });

  await notifyActs.notifyChat({
    chatId: input.requesterChatId,
    message: `Purchased ${input.label}.eth tx=${receipt.registrationTransactionHash}`,
  });
}
```

C’est le squelette pédagogique. Deux durcissements **obligatoires** avant prod :

1. **Boucle post-commit** : si juste après le `sleep(62s)` le prix n’est pas encore dans le budget, ne throw pas tout de suite — re-poll jusqu’à `committedAt + 23h`, puis **recommit** (nouvelle activity `commitName`). C’est le cas normal de la prime hollandaise.
2. **`continueAsNew`** : une boucle `sleep(30s)` pendant 21 jours = trop d’événements dans l’historique. Tous les N cycles (ex. 500), `continueAsNew(input)` pour reset l’historique. À ajouter dès que tu testes un poll > quelques minutes.

Import ESM : dans le workflow, `import type * as activities` (type-only) est obligatoire. Un import **valeur** depuis `ensDrop.activities.ts` embarquerait Nest/viem dans l’isolate → crash au bundle.

### 6.4 Adapter client

Il implémente `EnsWatchSchedulerPort` avec le Client.

**Fichier : `agents/src/infrastructure/adapters/temporal/TemporalWatchSchedulerAdapter.ts`**

```ts
import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { watchEnsDrop } from './workflows/watchEnsDrop.workflow.js';
import { cancelWatchSignal } from './workflows/watchEnsDrop.workflow.js';

start(watch) {
  const workflowId = `ens-drop:${watch.label}`;
  try {
    await this.client.workflow.start(watchEnsDrop, {
      workflowId,
      taskQueue: this.taskQueue,
      args: [{
        label: watch.label,
        years: watch.years,
        durationSeconds: watch.years * 365 * 24 * 3600,
        requesterChatId: watch.requesterChatId,
        maxWei: watch.maxWei,
        gracePeriodEndUnix: watch.gracePeriodEndUnix,
      }],
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
  } catch (e) {
    if (e instanceof WorkflowExecutionAlreadyStartedError) {
      throw … // domaine : watch déjà actif
    }
    throw e;
  }
  return { workflowId };
}

cancel(workflowId) {
  const handle = this.client.workflow.getHandle(workflowId);
  await handle.signal(cancelWatchSignal);
  // ou handle.cancel() pour tuer aussi un sleep en cours
}
```

`handle.cancel()` est plus brutal et annule un `sleep` immédiatement. Le signal permet de `notifyChat` proprement. Prends **les deux** : signal d’abord, `cancel()` si tu veux garantir l’arrêt du timer.

---

## 7. Phase 4 — Câblage Nest (la config qui fait mal si on la rate)

### 7.1 `temporal.config.ts`

**Fichier : `agents/src/infrastructure/adapters/temporal/temporal.config.ts`**

```ts
export type TemporalRuntimeConfig = {
  address: string;
  namespace: string;
  taskQueue: string;
  tls: boolean;
  apiKey?: string;
};

export function readTemporalConfig(config: ConfigService): TemporalRuntimeConfig {
  return {
    address: config.get<string>('TEMPORAL_ADDRESS') ?? '127.0.0.1:7233',
    namespace: config.get<string>('TEMPORAL_NAMESPACE') ?? 'default',
    taskQueue: config.get<string>('TEMPORAL_TASK_QUEUE') ?? 'ens-drop',
    tls: config.get<string>('TEMPORAL_TLS') === 'true',
    apiKey: config.get<string>('TEMPORAL_API_KEY') || undefined,
  };
}
```

### 7.2 Client (bot) — `BotModule`

**Fichier : `agents/src/bootstrap/BotModule.ts`** — à ajouter au tableau `providers` existant.

```ts
import { Client, Connection } from '@temporalio/client';

{
  provide: 'TEMPORAL_CLIENT',
  inject: [ConfigService],
  useFactory: async (config: ConfigService) => {
    const t = readTemporalConfig(config);
    const connection = await Connection.connect({
      address: t.address,
      tls: t.tls ? true : undefined,
      apiKey: t.apiKey,
    });
    return new Client({ connection, namespace: t.namespace });
  },
},
{
  provide: ENS_WATCH_SCHEDULER_PORT,
  inject: ['TEMPORAL_CLIENT', ConfigService],
  useFactory: (client: Client, config: ConfigService) =>
    new TemporalWatchSchedulerAdapter(
      client,
      readTemporalConfig(config).taskQueue,
    ),
},
```

Le bot **n’appelle pas** `Worker.create`. S’il le fait, tu auras deux workers sur la même queue dès que tu lances `start:worker` — les activities se dupliquent, le mutex EOA ne suffit plus à être évident.

### 7.3 Worker — `WorkerModule` + `worker.ts`

`workflowsPath` en ESM (pas de `require.resolve`).

**Fichier : `agents/src/bootstrap/WorkerModule.ts`**

```ts
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NativeConnection, Worker } from '@temporalio/worker';

const workflowsPath = fileURLToPath(
  new URL('../infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.js', import.meta.url),
);

{
  provide: 'TEMPORAL_WORKER',
  inject: [ConfigService, PurchaseEnsName, ENS_REGISTRAR_PORT, MESSAGING_PORT, ENS_LOOKUP_PORT],
  useFactory: async (config, purchase, registrar, messaging, lookup) => {
    const t = readTemporalConfig(config);
    const connection = await NativeConnection.connect({
      address: t.address,
      tls: t.tls ? true : undefined,
      apiKey: t.apiKey,
    });

    const activities = {
      refreshQuote: (input) => /* quote + lookup */,
      commitName: (input) => registrar.commit(input),
      registerName: (input) => registrar.register(input),
      notifyChat: ({ chatId, message }) =>
        messaging.send({ channel: 'telegram', recipientId: chatId, message }),
    };

    const worker = await Worker.create({
      connection,
      namespace: t.namespace,
      taskQueue: t.taskQueue,
      workflowsPath,
      activities,
    });
    return worker;
  },
}
```

**Fichier : `agents/src/bootstrap/worker.ts`**

```ts
import { NestFactory } from '@nestjs/core';
import { Worker } from '@temporalio/worker';
import { WorkerModule } from './WorkerModule.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const worker = app.get<Worker>('TEMPORAL_WORKER');
  await worker.run();
}

void bootstrap();
```

`createApplicationContext` : pas de HTTP, pas de Telegraf. Le worker n’a **pas** besoin de `TELEGRAM_BOT_TOKEN` pour poller Temporal, mais `notifyChat` oui — garde le token dans le `.env` du worker.

`OnModuleDestroy` : `worker.shutdown()`.

### 7.4 Isoler le bundle workflow

Le worker webpack/swc-bundle les workflows au démarrage. Si `watchEnsDrop.workflow.ts` importe un fichier qui importe Nest, **tout casse**.

Test de fumée :

```bash
pnpm start:worker
# Workflow bundle created
# Worker state: RUNNING
```

### 7.5 Deux terminaux

```bash
# 1
temporal server start-dev --db-filename /tmp/temporal.db

# 2
cd agents && pnpm start:dev

# 3
cd agents && pnpm start:worker
```

Sans le terminal 1 : `Connection.connect` hang / ECONNREFUSED au boot. Fail-fast : timeout 5 s sur le connect, message `Temporal is not reachable at TEMPORAL_ADDRESS`.

Sans le terminal 3 : `workflow.start` réussit, le workflow reste `Running` bloqué sur `Started` jusqu’à ce qu’un worker apparaisse — c’est normal, ce n’est pas un bug.

---

## 8. Phase 5 — Outil LangGraph `schedule_ens`

**Fichier : `agents/src/infrastructure/adapters/langgraph/tools/createEnsScheduleTool.ts`**, miroir de `createEnsPurchaseTool` :

- `action: quote | watch | cancel`
- `validate()` local avant tout RPC
- allowlist identique
- confirmation : `CONFIRM WATCH {NAME} FOR {N} YEAR(S)`
- le tool appelle `ScheduleEnsPurchase`, **jamais** le Client Temporal

Description de l’outil (à coller telle quelle pour le modèle) :

> Dates are already local. Do not compute grace from expiry. A watch buys when the name is available **and** the price is within budget. The 90-day grace end is not the purchase date because of the Dutch auction premium. Never claim a watch purchased the name unless the tool returns `purchased=true`.

Persona `Agent` : une ligne pour `schedule_ens`.

---

## 9. Tests

### 9.1 Use cases — fake scheduler

Pas de Temporal. Fake `EnsWatchSchedulerPort` en mémoire. C’est là que tu testes allowlist, policy, « déjà available → buy immédiat ».

### 9.2 Workflow — time skipping

`@temporalio/testing` lance un serveur Java qui **saute** les `sleep`.

**Fichier : `agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.spec.ts`**

```ts
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { watchEnsDrop } from '../watchEnsDrop.workflow.js';

const env = await TestWorkflowEnvironment.createTimeSkipping();

const worker = await Worker.create({
  connection: env.nativeConnection,
  taskQueue: 'test',
  workflowsPath: fileURLToPath(new URL('./watchEnsDrop.workflow.ts', import.meta.url)),
  activities: fakeActivities, // quote: unavailable 100 times then withinBudget
});

await worker.runUntil(async () => {
  await env.client.workflow.execute(watchEnsDrop, {
    workflowId: 'ens-drop:dayan',
    taskQueue: 'test',
    args: [/* gracePeriodEndUnix = now + 90 days */],
  });
});

await env.teardown();
```

Ce test **doit** passer en secondes, pas en 90 jours. Si tu attends vraiment, tu as oublié `createTimeSkipping`.

Fake activities : compteur d’appels `refreshQuote` ; après N polls `withinBudget: true` ; `commitName` / `registerName` enregistrent les appels. Assert : `commit` avant `register`, `register` une seule fois.

### 9.3 Adaptateur registrar

Déjà couvert en phase 1. Ne mélange pas un test Temporal et un test viem.

---

## 10. Sécurité (non négociable)

| Risque | Mitigation |
|---|---|
| Clé privée dans l’historique Temporal | Jamais dans `args`. L’activity lit `ConfigService` / l’adapter viem déjà construit. |
| Secret de commit dans Telegram | Le tool ne sérialise pas `secret`. Log Nest : hash seulement. |
| Retry `register` | `maximumAttempts: 1`. Timeout ≠ « ça n’a pas été miné ». |
| Chat non allowlisté | Use case, comme `purchase_ens`. Le workflow fait confiance à l’input déjà autorisé. |
| Deux workers, une EOA | Mutex registrar + un seul process `start:worker` en prod. |
| Budget changé en vol | `maxWei` snapshot dans l’input workflow. |

---

## 11. Production (Temporal Cloud) — checklist

1. Créer un namespace Cloud, coller address / namespace / API key dans le secret store, **pas** dans git.
2. `TEMPORAL_TLS=true`.
3. Pré-bundler les workflows au CI (`bundleWorkflowCode`) et passer `workflowBundle: { codePath }` au worker : le worker prod n’a pas besoin de webpackiser au boot.
4. Une réplica worker max tant que tu n’as pas un signer queue (nonce).
5. Alertes UI : workflow `Failed` avec type `COMMITTED_NOT_REGISTERED` → gas dépensé, nom pas à toi.
6. `WORKER_SHUTDOWN` gracieux (SIGTERM → `worker.shutdown()`) sinon un activity in-flight peut être repris ailleurs pendant qu’une tx est dans le mempool.

---

## 12. Ordre de merge (PRs petites)

1. Port `commit` / `register` + tests adapter. `buy()` inchangé.
2. `EnsDropWatch` + use cases + fake scheduler. Pas de Temporal.
3. `temporal server` local + worker hello-world (`sleep` + `notifyChat`) pour valider la config `.env`.
4. Workflow réel + time-skipping tests.
5. `schedule_ens` + persona.
6. Durcissement : recommit, `continueAsNew`, Cloud.

La PR 3 est volontairement stupide : si `TEMPORAL_ADDRESS` / ESM `workflowsPath` / deux process sont cassés, tu ne veux pas debugger ça **et** la prime ENS en même temps.

---

## 13. Commandes de debug

```bash
temporal workflow list --address 127.0.0.1:7233
temporal workflow describe -w ens-drop:dayan --address 127.0.0.1:7233
temporal workflow show -w ens-drop:dayan --address 127.0.0.1:7233   # event history
temporal workflow signal -w ens-drop:dayan --name cancelWatch --address 127.0.0.1:7233
temporal workflow cancel -w ens-drop:dayan --address 127.0.0.1:7233
```

UI : `http://127.0.0.1:8233/namespaces/default/workflows`. Un watch endormi 6 mois apparaît `Running` avec un timer ; c’est le comportement sain.

---

## 14. Ce que tu peux ignorer (pour l’instant)

- Schedules Temporal (`client.schedule.create`) : un workflow unique qui `sleep` jusqu’à une date **est** le schedule.
- Un block number cible : ENS compare `block.timestamp`, pas un `N` connu d’avance.
- Poll The Graph toutes les minutes pendant 6 mois : un `sleep` jusqu’à `graceEnd - 23h`, ensuite poll.
- `@nestjs/temporal` communautaire : le SDK officiel + un `useFactory`, tu contrôles ESM et le bundle.

Quand tu diras d’implémenter, on commence par la PR 1 (split du port). Tout le reste s’accroche là.

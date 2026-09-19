# Temporal, de `proxyActivities` jusqu'au fond

Tutoriel ancré sur le code de `agents/` et sur les traces réelles de deux
exécutions observées le 11 septembre 2026 : `ens-drop:dayan` et `ens-drop:degen`.

Tout ce qui est chiffré ici a été mesuré, pas supposé.

---

## Sommaire

1. [Le problème que Temporal résout](#1-le-problème-que-temporal-résout)
2. [Les trois acteurs](#2-les-trois-acteurs)
3. [L'idée centrale : le rejeu](#3-lidée-centrale--le-rejeu)
4. [La règle qui en découle : le déterminisme](#4-la-règle-qui-en-découle--le-déterminisme)
5. [Les activités : la soupape](#5-les-activités--la-soupape)
6. [`proxyActivities` décortiqué](#6-proxyactivities-décortiqué)
7. [Le voyage d'un argument](#7-le-voyage-dun-argument)
8. [Timeouts et réessais](#8-timeouts-et-réessais)
9. [L'historique : ce qui le fait grossir](#9-lhistorique--ce-qui-le-fait-grossir)
10. [Parler à un workflow vivant : signals et queries](#10-parler-à-un-workflow-vivant--signals-et-queries)
11. [Lire un workflow mort : le memo](#11-lire-un-workflow-mort--le-memo)
12. [Idempotence](#12-idempotence)
13. [Changer du code qui tourne jusqu'en 2034](#13-changer-du-code-qui-tourne-jusquen-2034)
14. [Tester : l'horloge qui saute](#14-tester--lhorloge-qui-saute)
15. [Observer en ligne de commande](#15-observer-en-ligne-de-commande)
16. [Récapitulatif des pièges](#16-récapitulatif-des-pièges)

---

## 1. Le problème que Temporal résout

Un utilisateur demande sur Telegram : « achète `degen.eth` dès qu'il tombe, si
c'est sous 0,02 ETH ». Le nom se libère le **13 janvier 2034**.

La version naïve :

```ts
setTimeout(() => buy('degen.eth'), 231_664_993_000); // 7,3 ans
```

Elle échoue pour six raisons indépendantes :

| | Ce qui casse |
| --- | --- |
| Redémarrage du processus | le timer disparaît, personne ne le sait |
| Déploiement | idem, et tu déploies plusieurs fois par jour |
| Crash pendant l'achat | le commit est miné, la révélation ne part jamais, tu as payé pour rien |
| Panne RPC transitoire | pas de réessai, le nom part à quelqu'un d'autre |
| Observabilité | impossible de répondre à « qu'est-ce qui est planifié ? » |
| Deux instances | deux achats, deux fois le prix |

Temporal ne rend pas ton code plus rapide ni plus intelligent. Il rend son
**exécution durable** : elle survit aux redémarrages, aux déploiements et aux
pannes, et elle reste interrogeable pendant des années.

---

## 2. Les trois acteurs

Le point qui débloque tout le reste : **le serveur Temporal n'exécute jamais ton
code**. Il ne l'a même pas.

| Acteur | Où, chez toi | Ce qu'il fait | Ce qu'il ne fait pas |
| --- | --- | --- | --- |
| **Serveur** | `temporal server start-dev` | garde l'historique, les timers, les files de tâches | exécuter ton code |
| **Worker** | `pnpm start:worker` → `WorkerModule` | **seul** endroit où ton code tourne : workflows *et* activités | décider quand |
| **Client** | `TemporalWatchSchedulerAdapter`, dans le bot | démarrer, signaler, interroger, lister | exécuter quoi que ce soit |

Le rendez-vous entre le serveur et le worker est la **file de tâches**, chez toi
`ens-drop` (`TEMPORAL_TASK_QUEUE`). Le worker interroge cette file, le serveur y
dépose du travail. Si les deux noms ne correspondent pas, rien ne se passe et
personne ne se plaint — c'est la première chose à vérifier quand un workflow
reste bloqué à `Running` sans rien faire.

```text
   BOT (BotModule)                SERVEUR                 WORKER (WorkerModule)
        │                            │                            │
        │ workflow.start() ─────────►│                            │
        │                            │  écrit l'historique        │
        │                            │  pose une tâche ──────────►│
        │                            │                     exécute watchEnsDrop
        │                            │◄──── commandes ────────────│
        │                            │  écrit, arme les timers    │
        │                            │                            │
et            2e réveil                     3e réveil
──────────                    ──────────                    ──────────
setHandler                    setHandler                    setHandler
Date.now()                    Date.now()                    Date.now()
   → 1757577579000               → REJOUÉ, même valeur         → REJOUÉ, même valeur
refresh()                     refresh()                     refresh()
   → appel réel                  → REJOUÉ depuis l'historique  → REJOUÉ
sleep(6h)                     sleep(6h)                     sleep(6h)
   → arme un timer, STOP         → REJOUÉ, déjà écoulé         → REJOUÉ
                              refresh()                     refresh()
                                 → appel réel                  → REJOUÉ
                              sleep(...)                    refresh()
                                 → arme un timer, STOP         → appel réel ← du neuf
```

Chaque réveil réexécute tout, mais **ne produit du travail neuf qu'au bout**.
C'est pour ça que l'historique ne peut jamais être élagué : il *est* l'état.

### La nuance du cache collant

En pratique, le worker garde l'instance du workflow en mémoire entre deux
réveils et ne lui fournit que les nouveaux événements — pas de rejeu complet.
C'est le **sticky cache**, et tu en as la trace dans l'historique de `dayan` :

```text
EVENT_TYPE_WORKFLOW_TASK_SCHEDULED
  taskQueue: { name: "71350@...-1aa736e4...", kind: TASK_QUEUE_KIND_STICKY,
               normalName: "ens-drop" }
```

Une file dédiée à *ce* worker précis, pour retomber sur l'instance en cache.

Mais le cache est une optimisation, pas une garantie : redémarrage du worker,
éviction, autre worker, et le rejeu complet reprend. **Écris toujours comme si ta
fonction repartait de la ligne 1 à chaque instant.**

---

## 4. La règle qui en découle : le déterminisme

Si la fonction est rejouée, elle doit produire **exactement la même suite de
décisions** à partir du même historique. Sinon Temporal détecte une divergence et
refuse de continuer.

D'où un bac à sable : le code de workflow tourne dans un **isolat V8 séparé**,
sans accès réseau ni disque. C'est aussi pourquoi le worker charge les workflows
depuis un **fichier sur disque** et non par un `import` ordinaire.

`agents/src/bootstrap/WorkerModule.ts:32-37`

```ts
const workflowsPath = fileURLToPath(
  new URL(
    '../infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.js',
    import.meta.url,
  ),
);
```

### Ce que le SDK remplace pour toi

Ces fonctions sont **interceptées** et rendues rejouables. Tu peux les utiliser
librement :

| Appel | Comportement au rejeu |
| --- | --- |
| `Date.now()`, `new Date()` | rend l'heure de la décision d'origine |
| `Math.random()` | même valeur |
| `uuid4()` | même valeur |
| `setTimeout`, `sleep()` | timer durable côté serveur |
| `Promise.race`, `condition()` | déterministes par construction |

C'est ce qui rend cette ligne légitime, alors qu'elle aurait l'air d'une faute :

`agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.ts:110-111`

```ts
  const armAtMs = input.gracePeriodEndUnix * 1000 - WAKE_UP_BEFORE_DROP_MS;
  const delay = armAtMs - Date.now(); // Date.now est patché par Temporal ici
```

Sans le patch, un rejeu six mois plus tard calculerait un `delay` négatif et
sauterait le sommeil. Avec, il retrouve la valeur du premier passage.

### Ce qui est interdit

`fetch`, `fs`, `process.env`, un client de base de données, un appel RPC,
`crypto.randomUUID`. Tout ce qui pourrait répondre différemment au deuxième
passage.

### Et si tu diverges quand même ?

Le workflow n'est pas perdu. La **tâche** échoue et est réessayée indéfiniment,
donc l'exécution se fige et attend. Tu déploies un correctif, la tâche repasse,
et le workflow reprend où il en était. C'est désagréable mais réversible.

---

## 5. Les activités : la soupape

Tout ce que le workflow ne peut pas faire, une **activité** le fait.

Une activité est une fonction ordinaire, dans le processus worker, sans aucune
contrainte : réseau, disque, signature de transaction, ce que tu veux. Son
**résultat est enregistré une fois** dans l'historique, puis rejoué pour toujours.

La division du travail est donc nette :

| | Workflow | Activité |
| --- | --- | --- |
| Rôle | **décide** de l'enchaînement | **agit** sur le monde |
| Contrainte | déterministe, bac à sable | aucune |
| Rejeu | rejoué en permanence | exécutée une fois, résultat relu |
| Chez toi | `watchEnsDrop.workflow.ts` | les quatre fonctions de `WorkerModule` |

Les tiennes sont déclarées dans `WorkerModule` — et c'est là que vit ta clé
privée, jamais dans le workflow :

```ts
const activities: EnsDropActivities = {
  async refreshQuote({ label, years, maxWei }) { /* The Graph + viem */ },
  async commitName({ label, durationSeconds, secret }) { /* transaction 1 */ },
  async registerName(input) { /* transaction 2 */ },
  async notifyChat({ chatId, message }) { /* Telegram */ },
};
```

---

## 6. `proxyActivities` décortiqué

Voilà l'objet qui a motivé ce document.

`agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.ts:27-41`

```ts
const quoteActs = proxyActivities<EnsDropActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2s',
    backoffCoefficient: 2,
    // Types portés par ApplicationFailure côté worker, depuis EnsPurchaseError.code.
    nonRetryableErrorTypes: [
      'INVALID_REQUEST',
      'OVER_BUDGET',
      'INSUFFICIENT_FUNDS',
      'NAME_UNAVAILABLE',
    ],
  },
});
```

### Ce que c'est vraiment

Un `Proxy` JavaScript vide. Rien d'autre. Quand tu écris
`quoteActs.refreshQuote(...)` :

1. le piège `get` intercepte le nom `refreshQuote` ;
2. il te rend une fonction qui **sérialise l'argument** et émet une commande
   « planifie l'activité nommée `refreshQuote` avec ce payload et ces options » ;
3. elle retourne une promesse qui ne se résoudra qu'au réveil suivant.

**Aucun code d'activité n'est importé ni appelé ici.** C'est structurel : le
workflow vit dans un isolat sans réseau, il ne *pourrait* pas exécuter
`refreshQuote`. Le lien entre les deux est une **chaîne de caractères**, le nom
de la méthode.

### Pourquoi le paramètre de type est purement décoratif

`EnsDropActivities` est un `type`, effacé à la compilation. Il ne sert qu'à
TypeScript : autocomplétion et vérification des signatures. À l'exécution, seul
le nom de méthode compte.

C'est ce qui rend ton fichier de contrat précieux — il n'a **aucun corps de
fonction**, seulement des types.

`agents/src/infrastructure/adapters/temporal/activities/ensDrop.activities.ts:60-65`

```ts
export type EnsDropActivities = {
  refreshQuote(input: RefreshQuoteInput): Promise<QuoteView>;
  commitName(input: CommitNameInput): Promise<CommitNameResult>;
  registerName(input: RegisterNameInput): Promise<RegisterNameResult>;
  notifyChat(input: NotifyChatInput): Promise<void>;
};
```

Le workflow s'en sert pour appeler, le worker pour déclarer
(`const activities: EnsDropActivities = {...}`). Oublie une méthode côté worker
et le compilateur te le dit, au lieu que tu le découvres six mois plus tard sur
un « activity type not registered ».

> **Détail qui fait perdre une heure :** c'est un `type`, pas une `interface`.
> `proxyActivities` exige une signature d'index implicite, et une `interface` n'en
> a pas. Avec `interface`, tu obtiens une erreur de contrainte générique obscure.

### Pourquoi quatre proxies au lieu d'un

Parce que les options portent sur le proxy, pas sur l'appel. Quatre besoins
différents, donc quatre proxies :

| Proxy | Timeout | Tentatives | Raison |
| --- | --- | --- | --- |
| `quoteActs` | 30 s | 5 | lecture bon marché, on insiste |
| `commitActs` | 2 min | 3 | une transaction, ça peut traîner |
| `registerActs` | 3 min | **1** | **ne jamais risquer de payer deux fois** |
| `notifyActs` | 20 s | 5 | Telegram tombe, ce n'est pas grave |

Le `maximumAttempts: 1` de `registerActs` est le choix le plus lourd du fichier :
un hoquet réseau au mauvais moment perd le nom. C'est assumé — perdre le nom
coûte moins cher que le payer deux fois.

---

## 7. Le voyage d'un argument

Reprenons `notifyChat`. Le workflow écrit ceci :

`agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.ts:92-95`

```ts
    await notifyActs.notifyChat({
      chatId: input.requesterChatId,
      message: `Cancelled watch on ${input.name}`,
    });
```

Trois temps, trois lieux :

```text
① WORKFLOW construit l'objet et le sérialise
      │
      │  commande ScheduleActivityTask
      ▼
② SERVEUR l'écrit dans l'historique, pour toujours
      │
      │  événement 1863 de ens-drop:dayan :
      │  {"chatId":"834948758","message":"Cancelled watch on dayan.eth"}
      │
      │  puis dépose une tâche sur la file ens-drop
      ▼
③ WORKER la prend, désérialise, et appelle TA fonction
      async notifyChat({ chatId, message }) { ... }   ← WorkerModule.ts:119
```

Ce payload existe réellement dans ton serveur : c'est celui du watch que tu as
annulé. Quatre conséquences pratiques.

**La sérialisation JSON est obligatoire.** D'où l'interdiction du `bigint` et les
montants en chaînes de wei dans le contrat. Ce qui ne survit pas à un
aller-retour JSON ne survit pas à ce trajet.

**Le worker qui exécute n'est pas forcément celui qui était vivant à la
planification.** Tu as redémarré ton worker plusieurs fois pendant que `dayan`
tournait, et il a continué : la commande était sur le serveur.

**Un réessai relit le même payload.** Temporal ne recalcule pas les arguments, il
relit l'événement. C'est *toute* la raison d'être de cette ligne :

`agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.ts:141-143`

```ts
  // Généré dans le workflow, donc identique à chaque replay : une activité
  // rejouée réutilise ce secret au lieu de miner un second commitment.
  const secret = `0x${`${uuid4()}${uuid4()}`.replace(/-/g, '')}`;
```

Si le secret était généré **dans** `commitName`, chacune des trois tentatives
minerait un commitment différent, et tu paierais trois fois du gas pour une
révélation qui n'en utiliserait qu'un.

**C'est auditable pour toujours.** Des mois plus tard, `temporal workflow show`
te dit exactement ce qui a été passé à quelle activité.

---

## 8. Timeouts et réessais

### `startToCloseTimeout`

Le temps maximum d'**une tentative**. Obligatoire. Dépassé, la tentative est
considérée échouée et la politique de réessai s'applique.

### Le piège des `nonRetryableErrorTypes`

Celui-ci t'a coûté cinq réessais inutiles sur un dépassement de budget.

Temporal compare des **types de failure**, c'est-à-dire des chaînes, pas des
classes JavaScript. Lever un `EnsPurchaseError` depuis une activité produit une
failure générique dont le type ne correspond à rien : la liste ne matche jamais,
et tout est réessayé.

La traduction se fait côté worker.

`agents/src/bootstrap/WorkerModule.ts:159-170`

```ts
async function asActivityFailure<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EnsPurchaseError) {
      throw error.retryable
        ? ApplicationFailure.retryable(error.message, error.code)
        : ApplicationFailure.nonRetryable(error.message, error.code);
    }
    throw error;
  }
}
```

Le deuxième argument d'`ApplicationFailure.nonRetryable` est le **type**. C'est
lui qui doit figurer dans `nonRetryableErrorTypes`. La règle à retenir : *un code
d'erreur métier doit devenir un type de failure Temporal à la frontière de
l'activité, sinon il ne veut rien dire pour le serveur.*

---

## 9. L'historique : ce qui le fait grossir

Chaque décision devient des événements. Un cycle « dormir puis coter » en coûte
une dizaine : timer armé, timer déclenché, tâche planifiée, démarrée, terminée,
activité planifiée, démarrée, terminée…

### Mesuré chez toi

Deux exécutions, deux régimes, le même code :

| | `ens-drop:degen` | `ens-drop:dayan` |
| --- | --- | --- |
| État | dort jusqu'en **2034** | bouclait sur le prix |
| Âge observé | 1,5 h | 1,45 h |
| Événements | **5** | **1 804** |
| Rythme | ~3/h | **1 246/h** |

Un sommeil durable est quasi gratuit : cinq événements pour sept ans d'attente.
Une boucle de polling, non.

### Les plafonds

Valeurs par défaut du serveur, configurables par namespace :

| Seuil | Événements | Taille | Effet |
| --- | --- | --- | --- |
| Suggestion | 4 096 | 4 Mo | `continueAsNewSuggested` passe à `true` |
| Avertissement | 10 240 | 10 Mo | log serveur |
| **Erreur** | **51 200** | **50 Mo** | l'exécution est **terminée** |

À 1 246 événements/h, `dayan` heurtait le mur en **40 heures**. Or il lui fallait
environ 20 jours pour que le premium retombe sous 0,02 ETH. Il était condamné à
mourir dix-huit jours avant de pouvoir acheter.

### Les deux réponses

**Ne pas sonder à l'aveugle.** La décote ENS est une fonction connue du temps :
le premium est divisé par deux chaque jour. On sait donc estimer quand il
croisera le budget, et dormir jusque-là. C'est ce que calcule `pollSchedule.ts` :

```text
halvings = log2(premium / (budget − prix_hors_premium))
attente  = halvings × 24 h × 0,8      borné à [30 s, 6 h]
```

Résultat : environ 85 réveils sur 20 jours au lieu de 57 600. Le facteur 0,8 est
une marge — l'estimation suppose un cours ETH figé, et se réveiller trop tôt ne
coûte qu'une cotation quand trop tard coûte le nom.

**`continueAsNew`, le filet.** Quand le serveur le suggère, le workflow se
termine et en redémarre un aussitôt : **même `workflowId`, nouveau `runId`,
historique vierge**.

`agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.ts:122-128`

```ts
  while (!quote.available || !quote.withinBudget) {
    // L'historique est rejoué en entier à chaque réveil, donc il ne peut pas
    // être élagué et une attente longue finit par heurter le plafond du
    // serveur. Celui-ci prévient avant : on redémarre alors sur une exécution
    // neuve, ce que l'appelant ne voit même pas.
    if (workflowInfo().continueAsNewSuggested) await rearm(input);
```

Trois règles à ne pas oublier :

- **Seuls les arguments survivent.** Les variables locales disparaissent. C'est
  le principe : tu choisis explicitement ce qui traverse.
- **Le memo n'est pas hérité.** Le SDK ne reporte que le type de workflow et la
  file. Comme c'est le memo que lit ton reporting, il faut le repasser — d'où la
  fonction `rearm`.
- **Côté lecture, exclure les anciens runs.** Ils gardent le memo, donc sans
  filtre un nom apparaît une fois par rotation. Et `result()` suivrait la chaîne
  jusqu'au run courant au lieu de rendre un statut :
  `WorkflowType = 'watchEnsDrop' AND ExecutionStatus != 'ContinuedAsNew'`.

Enfin, ne place jamais un `continueAsNew` au milieu d'une séquence où l'état
compte. Chez toi il est dans la boucle d'attente, jamais entre `commitName` et
`registerName` — couper là perdrait le secret et le hash du commitment.

---

## 10. Parler à un workflow vivant : signals et queries

Deux canaux, deux natures.

### Signal — écrit, asynchrone, enregistré

Un signal **mute l'état** et devient un événement de l'historique, donc il est
rejoué comme le reste. Le handler doit rester trivial :

`agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.ts:78-80`

```ts
  setHandler(cancelWatchSignal, () => {
    cancelled = true;
  });
```

Mettre un drapeau, rien de plus. Le workflow le lit où il veut, et la façon de le
lire compte : un `await sleep(6h)` nu ignorerait une annulation pendant six
heures. D'où la course :

`agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.ts:131-135`

```ts
    await Promise.race([
      sleep(nextPollMs(quote, input.maxWei, Date.now())),
      condition(() => cancelled),
    ]);
    await abortIfCancelled();
```

`condition(fn)` est un `await` qui se débloque quand `fn()` devient vrai, réévalué
à chaque changement d'état. Couplé à `Promise.race`, c'est le motif standard du
« dors longtemps, mais reste réveillable ».

### Query — lecture seule, synchrone, **jamais** sur un mort

Une query ne produit **aucun** événement et ne doit **rien** modifier. Elle
n'existe que parce que le statut Temporal (`Running`) ne distingue pas « dort
encore sept ans » de « commitment miné, achat imminent » :

```ts
export const watchPhaseQuery = defineQuery<EnsDropWatchStatus>('watchPhase');
```

Sa limite est structurelle : une query exige un worker vivant pour l'évaluer. Un
worker éteint, ou une exécution terminée, et il n'y a pas de réponse. D'où la
prudence côté adaptateur : sur échec, on affiche le stade le plus conservateur.

> `signal` mute et laisse une trace. `query` observe et ne laisse rien.
> Si tu es tenté de muter dans une query, c'est un signal qu'il te faut.

---

## 11. Lire un workflow mort : le memo

Le `memo` est un sac de données attaché à l'exécution au démarrage. Immuable, non
filtrable — et surtout **lisible après la fin de l'exécution**, contrairement à
une query.

`agents/src/infrastructure/adapters/temporal/TemporalWatchSchedulerAdapter.ts:57-66`

```ts
      await this.client.workflow.start(watchEnsDrop, {
        workflowId,
        taskQueue: this.taskQueue,
        args: [watch],
        memo: { ...watch },
        // L'id dérive du label, donc deux demandes sur le même nom se
        // télescopent. Le serveur refuse la seconde, ce qui rend l'armement
        // idempotent sans état de notre côté.
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      });
```

C'est ce qui permet à `list_ens_watches` de fonctionner **sans base de données**.
Trois canaux de lecture complémentaires :

| Canal | Contenu | Survit à la fin ? | Filtrable côté serveur ? |
| --- | --- | --- | --- |
| `memo` | les faits figés du watch | **oui** | non |
| statut d'exécution | `Running`, `Failed`… | oui | oui |
| `query` | la phase courante | **non** | non |

L'alternative aux memos serait les **search attributes**, filtrables côté serveur
mais qui exigent d'être déclarés sur le namespace au préalable. Un oubli de cette
étape d'infra fait échouer `start` lui-même : trop fragile pour un gain de
filtrage sur une poignée de watchs.

---

## 12. Idempotence

Le `workflowId` est la clé d'idempotence. Chez toi il dérive du label :

```ts
export function workflowIdFor(label: string): string {
  return `ens-drop:${label}`;
}
```

Deux demandes sur le même nom produisent le même id, et
`workflowIdReusePolicy: 'REJECT_DUPLICATE'` fait refuser la seconde par le
serveur. Le SDK lève `WorkflowExecutionAlreadyStartedError`, traduit en
`ALREADY_STARTED` puis en `ALREADY_WATCHED` pour l'utilisateur.

**L'idempotence ne coûte aucun état de ton côté**, c'est le serveur qui la
garantit. Si tu te retrouves à tenir une table « déjà planifié », c'est souvent
que l'id du workflow n'encode pas la bonne chose.

Au niveau de l'activité, en revanche, l'idempotence est ton problème : une
activité peut être exécutée plus d'une fois (réessai, ou timeout suivi d'un
succès tardif). Le secret passé en argument est précisément la réponse à ça pour
`commitName`.

---

## 13. Changer du code qui tourne jusqu'en 2034

Le piège de production numéro un, et il te concerne dès maintenant : `degen`
tourne jusqu'en 2034, ton code change plusieurs fois par jour.

### La règle

Une exécution en cours est rejouée contre le **code déployé aujourd'hui**, pas
celui de son démarrage. Si le nouveau code émet des commandes différentes de
celles enregistrées, c'est une divergence.

D'où un critère simple :

> Un changement est sans danger pour une exécution en cours **si celle-ci n'a pas
> encore atteint la partie changée**. Il est dangereux pour ce qu'elle a déjà
> franchi.

Illustration réelle : passer le sommeil de la boucle de 30 s fixes à un
intervalle adaptatif aurait cassé `dayan`, qui était dans la boucle. Ça n'a rien
cassé pour `degen`, qui dort encore *avant* la boucle et n'a donc aucun timer de
polling enregistré. Et comme la marge de réveil (`WAKE_UP_BEFORE_DROP_MS`) n'a
pas bougé, son timer déjà armé reste cohérent.

### Ce qui casse, ce qui ne casse pas

| Changement | Sûr sur une exécution en cours ? |
| --- | --- |
| Message passé à `notifyChat` | oui, c'est un argument |
| Ajouter un champ optionnel à un payload | oui |
| Retirer, réordonner ou ajouter un appel d'activité déjà franchi | **non** |
| Changer la durée d'un timer déjà armé | **non** |
| Renommer une activité | **non** |
| Changer les options de retry ou de timeout | oui |
| Réécrire le corps d'une activité | oui, elle n'est pas rejouée |

Le dernier point mérite d'être souligné : **les activités sont libres**. Tu peux
réécrire `refreshQuote` entièrement, c'est le workflow qui est contraint.

### `patched()`, quand tu dois vraiment changer le milieu

```ts
import { patched } from '@temporalio/workflow';

if (patched('adaptive-poll-v2')) {
  await sleep(nextPollMs(quote, input.maxWei, Date.now())); // nouveau chemin
} else {
  await sleep(30_000);                                      // ancien chemin
}
```

`patched(id)` rend `true` pour les nouvelles exécutions et pour celles qui ont
déjà enregistré ce marqueur, `false` pour celles qui ont franchi ce point sans
lui. Les anciennes finissent sur l'ancien chemin, les nouvelles sur le nouveau.

Le cycle de vie complet :

1. déployer avec `patched('x')` et les deux branches ;
2. attendre l'extinction des exécutions antérieures ;
3. remplacer par `deprecatePatch('x')` ;
4. supprimer l'appel une fois tout redéployé.

Avec des watchs à sept ans, cette gymnastique est intenable. L'alternative
pragmatique pour un nom loin dans le futur : **annuler et réarmer**. Le watch ne
porte aucun état précieux avant le commit, donc le relancer ne coûte rien — et
c'est très exactement pourquoi il faut que réarmer reste gratuit.

---

## 14. Tester : l'horloge qui saute

Un workflow qui dort sept ans est testable en millisecondes. Le serveur de test
de Temporal avance son horloge dès que tout le monde attend un timer.

```ts
env = await TestWorkflowEnvironment.createTimeSkipping();
```

Puis un worker jetable, des activités simulées, et le chemin complet se déroule
d'un coup. C'est le seul endroit où `commitName` et `registerName` s'exécutent
avant de le faire avec une vraie clé.

Voir `agents/src/infrastructure/adapters/temporal/workflows/watchEnsDrop.e2e-spec.ts`,
qui couvre les cinq chemins qui coûtent de l'argent :

| Test | Ce qu'il protège |
| --- | --- |
| achat nominal | et que `registerName` réutilise le secret du commit |
| prix sorti du budget après le commit | ne jamais dépenser sur une cotation périmée |
| nom renouvelé par le titulaire | s'arrêter au lieu d'attendre pour rien |
| annulation pendant le sommeil long | la course `sleep` / `condition` |
| annulation pendant l'attente de polling | idem, dans la boucle |

```bash
pnpm test:e2e   # télécharge le serveur de test au premier lancement
```

Ces tests vivent en `*.e2e-spec.ts` pour rester hors de la suite rapide.

---

## 15. Observer en ligne de commande

```bash
# Le serveur répond-il ? (attendu : SERVING)
temporal operator cluster health

# Les watchs, en excluant les runs remplacés par un continueAsNew
temporal workflow list \
  --query "WorkflowType = 'watchEnsDrop' AND ExecutionStatus != 'ContinuedAsNew'"

# Tout sur une exécution : memo, statut, taille d'historique
temporal workflow describe --workflow-id 'ens-drop:degen'

# La phase interne, via la query — seulement si un worker tourne
temporal workflow query --workflow-id 'ens-drop:degen' --type watchPhase

# L'historique complet : timers, activités, payloads
temporal workflow show --workflow-id 'ens-drop:degen'

# Annuler proprement : le workflow prévient le chat avant de s'arrêter
temporal workflow signal --workflow-id 'ens-drop:degen' --name cancelWatch
```

Et l'interface web sur <http://localhost:8233>.

Deux réflexes de diagnostic :

- **`Running` mais rien ne bouge** → la file. Compare `TEMPORAL_TASK_QUEUE` et la
  `TaskQueue` du `describe`. Ou le worker est mort.
- **Rien dans `list` alors que le bot dit avoir planifié** → vérifie
  `ENS_WATCH_SCHEDULER=temporal` dans `.env`. Sinon l'ordonnanceur en mémoire est
  actif et Temporal n'a jamais rien vu.

---

## 16. Récapitulatif des pièges

| Piège | Symptôme | Ce qu'il faut faire |
| --- | --- | --- |
| I/O dans le workflow | divergence, exécution figée | déplacer dans une activité |
| `interface` pour le contrat d'activités | erreur générique obscure | utiliser `type` |
| Code d'erreur métier levé tel quel | réessais sur une erreur définitive | `ApplicationFailure.nonRetryable(msg, code)` |
| Valeur aléatoire générée dans l'activité | effet de bord dupliqué au réessai | la générer dans le workflow, la passer en argument |
| `await sleep(longtemps)` nu | signal ignoré pendant des heures | `Promise.race([sleep, condition])` |
| Boucle de polling serrée | historique saturé, exécution terminée | intervalle dérivé du modèle, plus `continueAsNew` |
| `continueAsNew` sans memo | reporting aveugle après rotation | repasser `memo` explicitement |
| `list` sans filtre de statut | doublons, `result()` qui bloque | exclure `ContinuedAsNew` |
| Modifier le milieu d'un workflow en cours | divergence | `patched()`, ou annuler et réarmer |
| `workflowsPath` erroné | `ENOENT` au démarrage du worker | chemin résolu depuis le fichier **émis** |
| Deux `nest start` sur le même `outDir` | `ENOENT` intermittent | un `tsconfig` et un `outDir` par processus |
| Provider Temporal instancié en dur | le bot ne démarre plus sans le serveur | choisir l'implémentation par variable d'environnement |

---

## Pour aller plus loin

- [docs.temporal.io/workflows](https://docs.temporal.io/workflows) — le modèle
- [docs.temporal.io/develop/typescript](https://docs.temporal.io/develop/typescript) — le SDK
- [`TEMPORAL_ENS_WATCH.md`](./TEMPORAL_ENS_WATCH.md) — la conception du watch ENS de ce projet

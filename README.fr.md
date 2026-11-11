# dsh-all-usage

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-all-usage?label=npm&color=4D6BFE)](https://www.npmjs.com/package/dsh-all-usage)
[![downloads](https://img.shields.io/npm/dt/dsh-all-usage?label=downloads&color=4D6BFE)](https://www.npmjs.com/package/dsh-all-usage)
[![stars](https://img.shields.io/github/stars/ParticleLight/dsh-all-usage?label=stars&logo=github)](https://github.com/ParticleLight/dsh-all-usage/stargazers)
[![license](https://img.shields.io/github/license/ParticleLight/dsh-all-usage?label=license&color=green)](LICENSE)
[![CI](https://github.com/ParticleLight/dsh-all-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/ParticleLight/dsh-all-usage/actions/workflows/ci.yml)
[![DSH runtime compatibility](https://img.shields.io/badge/DSH%20runtime-11%20verified-4D6BFE)](#compatibilité-et-limitations-connues)
[![status](https://img.shields.io/badge/status-stable-brightgreen)](https://github.com/ParticleLight/dsh-all-usage/releases)

[中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

## Introduction

Un tableau de bord complet de l'utilisation pour DeepSeek Harness. Analysez les tokens, le comportement du cache, le coût estimé, le solde du compte et l'activité par modèle, fournisseur, espace de travail et plage de dates.

Destiné aux utilisateurs de DSH qui souhaitent examiner la consommation de tokens, le coût par modèle et l'activité des espaces de travail à partir des données de session locales.

## Démarrage rapide

~~~bash
dsh plugin --profile web add github:ParticleLight/dsh-all-usage
~~~

La commande d'installation assemble le bundle. En général, il suffit de rafraîchir la page du navigateur pour charger le client, sans modification manuelle du profil. Si votre version de DSH n'assemble pas dynamiquement les paquets nouvellement installés, utilisez le rechargement de paquet prévu à cet effet ou redémarrez, puis rafraîchissez la page et ouvrez le tableau de bord depuis la barre latérale de DSH.

## Fonctionnalités principales

- **Explorez l'utilisation sous tous les angles** : consultez les synthèses, les tendances, les cartes de chaleur et les journaux de requêtes paginés ; combinez les filtres de date, d'espace de travail, de fournisseur et de modèle, puis exportez la vue courante en CSV.
- **Comprenez les modèles et les espaces de travail** : comparez les vues modèle mixte, modèle fusionné et fournisseur, avec séries, répartition par espace de travail et détail des tours par jour ; 43 marques sont intégrées et une identité de modèle inconnue reste neutre.
- **Configurez les coûts et les soldes** : estimez le coût à partir des quatre buckets de tokens, associez les modèles officiels ou définissez des prix manuels, configurez les paliers de contexte et les plages de pointe, et interrogez le solde du compte ; voir la section Configuration ci-dessous.
- **Synchronisez tout l'historique de façon incrémentale** : analysez les sessions lisibles, réutilisez les données de registre inchangées par session grâce aux révisions persistées, ne relisez que les journaux modifiés et suivez les changements du registre des espaces de travail de DSH.
- **Auditez le fonctionnement courant** : contrôlez la santé de l'analyse, les lectures, les restaurations de registre et les échecs ; changez la langue de l'interface, gérez les alias d'espaces de travail et vérifiez la version du plugin en cours d'exécution.

## Visite de l'interface

Ces captures d'écran ont été prises le 2026-11-11 sur une installation en fonctionnement (hôte 1.2.3 avec le client 1.2.4) : interfaces chinoise et anglaise, thème sombre. Les données d'utilisation et d'espaces de travail affichées appartiennent à cet environnement de capture.

### Vue d'ensemble du tableau de bord

L'en-tête regroupe l'état de version et les outils (alias d'espaces de travail, réglages des coûts, maintenance, langue de l'interface) ; en dessous se trouvent la plage de dates (Aujourd'hui / 7 derniers jours / 30 derniers jours / 90 derniers jours / Ce mois-ci / Tout l'historique / Personnalisé) et les filtres d'espace de travail, de fournisseur et de modèle. La carte principale affiche le total de tokens, le nombre de requêtes et le coût estimé pour la plage, suivis du solde du compte, du nombre total d'utilisations, de la série en cours, de la répartition par espace de travail et du taux de succès du cache.

![Vue d'ensemble du tableau de bord](assets/screenshots/en/01-overview.png)

### Tendance d'utilisation

Une tendance par jour, en courbe ou en barres ; cliquez sur un point pour lire la journée correspondante. Les plages longues sont sous-échantillonnées en points de trois jours, puis en semaines, mois, trimestres ou années, avec un plafond de 180 points par graphique.

![Tendance d'utilisation (courbe)](assets/screenshots/en/02-trend.png)

En mode barres, les mêmes données se lisent par jour, avec la même infobulle et le même détail de journée.

![Tendance d'utilisation (barres)](assets/screenshots/en/02-trend-bars.png)

### Carte de chaleur d'utilisation

Trois périodes — 30 jours, 90 jours et 12 mois — avec les jours de la semaine alignés par ligne et une intensité de couleur indiquant le volume de tokens de chaque jour.

![Carte de chaleur d'utilisation](assets/screenshots/en/03-heatmap.png)

### Statistiques des modèles et des espaces de travail

La zone de détail propose les journaux de requêtes, les statistiques de modèles et les statistiques d'espaces de travail. Les statistiques de modèles peuvent être fusionnées par vue combinée, par modèle ou par fournisseur, avec par ligne les appels, l'entrée, les hits de cache, la sortie, le raisonnement, le total, le coût et le taux de succès ; les statistiques d'espaces de travail s'agrègent par espace de travail et respectent vos alias.

![Statistiques des modèles](assets/screenshots/en/04-model-stats.png)

### Journaux de requêtes

Chaque requête est listée de la plus récente à la plus ancienne avec son modèle, ses tokens et son coût, et la vue filtrée courante s'exporte en CSV ; les compteurs d'audit comme la réutilisation de révision, les lectures et les restaurations de registre figurent dans la ligne de synchronisation en haut de la page.

![Journaux de requêtes](assets/screenshots/en/05-request-logs.png)

### Réglages des coûts

Le coût est estimé à partir de quatre buckets de tokens : association aux modèles officiels, prix manuels, paliers de contexte et plages de pointe, auxquels s'ajoute la consultation du solde du compte.

![Réglages des coûts](assets/screenshots/en/06-cost-settings.png)

### Maintenance

Les sessions inchangées depuis un certain temps sont repliées dans des fichiers mensuels compressés : prévisualisez d'abord les enregistrements concernés, leur taille et les mois visés, puis lancez l'opération ; les enregistrements archivés restent lisibles et comptabilisables.

![Maintenance](assets/screenshots/en/07-maintenance.png)

## Pile technologique et architecture

- **Hôte** (point d'entrée `lib/index.js`, assemblé par `lib/plugin.js`) : découpé par responsabilité en `aggregation.js` (agrégation et requêtes), `ledger.js` (registre persistant), `session-sync.js` (synchronisation de l'historique et du temps réel), `pricing-runtime.js` (tarification à l'exécution), `balance.js` (solde) et `http.js` (routes protégées) ; agrège `turn/end`, l'usage des `assistant/chunk` et le `assistant/message.usage` final, replie les mises à jour `session/event` en temps réel et expose les routes de données via `webServer`.
- **Client** : le code source lisible se trouve dans `src/client.js` ; `npm run build:client` utilise la version figée de Terser pour générer le bundle `window.__ModuleLoader__` dans `lib/client.js`, qui enregistre l'entrée de barre latérale « Statistiques d'utilisation » via l'emplacement `sidebar.footer.action`. Toutes les routes d'API acceptent les requêtes loopback et rejettent un en-tête Origin explicite inter-origines ; la lecture du solde et l'écriture des alias exigent en plus un jeton lié au processus, généré au démarrage du plugin (le GET du solde tolère un navigateur qui omet Origin). **Les écritures sont autorisées par ce jeton, pas par un Origin** : l'enveloppe de bureau de DSH exécute l'interface sur son propre schéma et transmet les requêtes via Electron, qui supprime `Origin` (avec `Host`/`Cookie`/`Sec-Fetch-*`) ; exiger cet en-tête faisait donc échouer chaque enregistrement côté bureau avec un 403. Un `Origin` présent doit tout de même être loopback ou celui du schéma de l'enveloppe, et `Host` doit rester loopback (protection contre le rebinding DNS).

![Schéma de l'architecture du système All Usage](assets/readme-architecture-en.svg)

### Flux de données historiques et temps réel

![Flux de réutilisation des révisions de l'historique et d'écriture du registre par session en temps réel](assets/readme-sync-en.svg)

### Stockage et performances

- **Un enregistrement par session** : le registre écrit chaque session dans son propre document (haché de façon stable dans 32 répertoires), si bien qu'une mise à jour ne publie qu'un seul fichier. Mesuré sur les mêmes données : une mise à jour est passée de la réécriture d'un fragment de 13,27 Mo (273 ms) à l'écriture d'un seul enregistrement (médiane de 4,6 ms).
- **Une seule identité par route** : les éléments d'usage référencent l'identité de route et sa définition de prix au lieu de les répéter, ce qui a fait passer 1 059 enregistrements de **91,3 à 74,7 Mo (-18 %)**
- **L'instantané ne paie que pour un seul fuseau horaire** : `GET /api/all-usage?utc=0|1` renvoie un seul calendrier (les deux copies se partageaient auparavant la charge utile en deux), et un jour conserve le détail de ses identifiants de session sur les **180 derniers jours**, tandis que les jours plus anciens ne gardent que les compteurs et les agrégats
- **Le graphique de tendance est plafonné à 180 points** : au-delà de six mois, il passe à un point pour trois jours puis s'élargit en semaine / mois / trimestre / année, de sorte que le graphique ne grossit pas avec l'historique
- **Les budgets sont dans le code** : 20 entrées de cache pour les requêtes et 20 pour les enregistrements, 5 000 résolutions de prix, 512 entrées de contexte par session, 500 lignes de prix, 32 fragments, 180 points de tendance et une fenêtre de 180 jours pour les identifiants de session - le tout gardé par `test/perf-budgets.test.js`, si bien qu'assouplir une valeur impose de modifier ce tableau
- **Des benchmarks reproductibles** : `node bench/ledger.mjs` (taille du registre et coût de réécriture par mise à jour), `node bench/ledger-layout.mjs` (les deux dispositions de stockage, sur des copies de fragments réels) `node bench/endpoints.mjs` (latence médiane et charge utile de cinq points de terminaison de lecture) et `node scripts/dead-code.mjs` (exports que rien ne référence, fonctions du client que personne n'appelle, classes de feuille de style qu'aucun balisage ne peut produire)

## Installation

Il s'agit d'un paquet de plugin communautaire DSH standard, avec un manifeste `dsh.bundle` et un Web Client. Il lit les journaux de session persistés et un registre d'utilisation séparé, puis remplit l'historique à l'activation.

### Compatibilité et limitations connues

- **Environnement d'exécution** : Node.js `>=22 <25` est requis. La CI exécute la suite de tests, les vérifications de syntaxe et le contrôle du contenu du paquet sur Node 22 et Node 24.
- **Compatibilité DSH** : `package.json` déclare la runtime DSH `>=0.1.1-rc.1 <0.1.5-0 || >=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.2 <0.1.8-0 || >=0.2.0-rc.2 <0.2.1-0 || 0.2.1-alpha.2 || 0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.2-alpha.3 || 0.2.2-rc.1` ; la véritable chaîne de services Cordis est vérifiée localement sur `0.2.1-rc.1` et `0.2.1-rc.2` (smoke strict sur Node 24 ; les deux font passer Cordis en version stable 4.0.5 / loader 1.0.6 / timer 1.1.7), `0.2.1-alpha.2`, `0.2.0-rc.2`, `0.1.7-rc.2`, `0.1.5-rc.2`, `0.1.5-rc.1`, `0.1.1-rc.2` et `0.1.1-rc.1`. Toutes les runtimes déclarées figurent dans la matrice smoke de la CI sur Node 22 et 24, mais les deux lignes `0.2.1` sont signalées SKIPPED — et non réussies — parce que l'amont n'a jamais publié la version correspondante de `@deepseek-ai/dsh-invariants`. `0.1.2-rc.1` a aussi été vérifiée compatible en usage réel, mais n'est pas couverte par la matrice smoke de la CI. La déclaration est découpée par tuple plutôt qu'écrite en un seul intervalle parce que node-semver n'admet une version préliminaire que si un comparateur partage exactement son tuple `major.minor.patch` et porte lui-même un tag de prépublication — `0.2.0-rc.2` n'est admise que parce que la plage dit `>=0.2.0-rc.2`.
- **Client de bureau (Electron, Windows)** : le plugin est vérifié en fonctionnement dans le client de bureau DSH (`@deepseek-ai/dsh-desktop` `0.1.7-rc.2` au moment des mesures). Le client de bureau réserve une bande de titre de 40 px en haut de sa fenêtre pour ses propres boutons réduire / agrandir / fermer et marque le document avec `data-windows-titlebar` et `--dsh-windows-titlebar-height` ; le panneau se dessine **sous** cette bande, si bien que le bouton de fermeture du client n'est jamais recouvert. Les navigateurs ne portent pas ce marqueur et ne réservent rien. La hauteur de la bande provient d'abord de la déclaration de l'hôte, puis du rectangle Window Controls Overlay, puis de l'agent utilisateur ; pour l'ajuster, exécutez `localStorage.setItem('dsh-all-usage:topInset', '48')` dans les DevTools et rechargez (`0` ne réserve rien) — aucune reconstruction n'est nécessaire. Le client de bureau embarque sa propre runtime ; la version mesurée, `0.1.7-rc.2`, fait partie de la plage déclarée et de la matrice smoke de la CI ci-dessous.
- **Dépendance au service web** : l'hôte déclare `webServer` comme dépendance obligatoire, de sorte que DSH attend un service monté tardivement avant d'appliquer le plugin ; ce paquet cible le profil Web de DSH et n'expose aucune route sans WebServer. Le garde HTTP vérifie aussi le pair réel de la socket, si bien qu'un proxy inverse n'est accepté que si la connexion elle-même est en loopback.
- **Langue de l'interface** : à la première ouverture, le panneau suit le réglage **Language** de DSH (`Settings → General → Language`, lu via le service `locale` de l'hôte) ; sans ce service, il se rabat sur la langue du navigateur, puis sur l'anglais. Dès qu'une langue est choisie dans le panneau, c'est ce choix qui prime et le réglage de l'hôte ne le remplace plus. La langue détermine aussi le fuseau horaire — le chinois utilise l'heure locale, l'anglais UTC — donc la changer recharge l'instantané correspondant.

| Runtime DSH | Prise en charge de Node.js | Smoke Cordis réel | Conclusion |
| --- | --- | --- | --- |
| `0.2.2-rc.1` | `>=22 <25` | Réussi (smoke Cordis réel et strict vérifié localement sur Node 24 ; Cordis stable 4.1.0 / loader 1.1.0 / timer 1.2.0) | Déclaré et vérifié (cette rc exacte uniquement ; la CI signale SKIPPED car l'amont n'a jamais publié `dsh-invariants@0.2.2-rc.1`) |
| `0.2.2-alpha.3` | `>=22 <25` | Réussi (smoke Cordis réel et strict vérifié localement sur Node 24 ; Cordis préliminaire 4.0.6-alpha.2 / loader 1.0.7-alpha.2 / timer 1.1.8-alpha.2) | Déclaré et vérifié (cette alpha.3 exacte uniquement ; aucune autre version alpha n'est impliquée ; la CI signale SKIPPED car l'amont n'a jamais publié `dsh-invariants@0.2.2-alpha.3`) |
| `0.2.1-rc.2` | `>=22 <25` | Réussi (smoke Cordis réel et strict vérifié localement sur Node 24 ; Cordis stable 4.0.5 / loader 1.0.6 / timer 1.1.7) | Déclaré et vérifié (cette rc exacte uniquement ; la CI signale SKIPPED car l'amont n'a jamais publié `dsh-invariants@0.2.1-rc.2`) |
| `0.2.1-rc.1` | `>=22 <25` | Réussi (smoke Cordis réel et strict vérifié localement sur Node 24 ; Cordis stable 4.0.5 / loader 1.0.6 / timer 1.1.7) | Déclaré et vérifié (cette rc exacte uniquement ; aucune autre version rc n'est impliquée ; la CI signale SKIPPED car l'amont n'a jamais publié `dsh-invariants@0.2.1-rc.1`) |
| `0.2.1-alpha.2` | `>=22 <25` | Réussi (smoke Cordis réel et strict vérifié localement sur Node 24 ; la CI signale SKIPPED car l'amont n'a jamais publié `dsh-invariants@0.2.1-alpha.2`) | Déclaré et vérifié (cette alpha.2 exacte uniquement ; aucune autre version alpha n'est impliquée) |
| `0.2.0-rc.2` | `>=22 <25`, la CI couvre 22/24 | Réussi (chaîne de services Cordis réelle, la CI couvre Node 22/24) | Déclaré et vérifié (vérifié historiquement ; la CI couvre Node 22/24) |
| `0.1.7-rc.2` | `>=22 <25`, la CI couvre 22/24 | Réussi (chaîne de services Cordis réelle, la CI couvre Node 22/24) | Déclaré et vérifié (vérifié historiquement ; la CI couvre Node 22/24) |
| `0.1.5-rc.2` | `>=22 <25`, la CI couvre 22/24 | Réussi (chaîne de services Cordis réelle, la CI couvre Node 22/24) | Déclaré et vérifié |
| `0.1.5-rc.1` | `>=22 <25`, la CI couvre 22/24 | Réussi (chaîne de services Cordis réelle, la CI couvre Node 22/24) | Déclaré et vérifié |
| `0.1.2-rc.1` | `>=22 <25` | Réussi via un usage réel (hors CI) | Compatibilité vérifiée en usage réel |
| `0.1.1-rc.2` | `>=22 <25`, la CI couvre 22/24 | Réussi (chaîne de services Cordis réelle, la CI couvre Node 22/24) | Déclaré et vérifié |
| `0.1.1-rc.1` | `>=22 <25`, la CI couvre 22/24 | Réussi (chaîne de services Cordis réelle, la CI couvre Node 22/24) | Déclaré et vérifié |
| Autres versions | `>=22 <25` | Non testé | Hors de la matrice vérifiée |

Une version de DSH non listée n'est pas forcément incompatible. Indiquez les versions de DSH, de Node.js et du plugin lorsque vous signalez un problème.

- **Requêtes interrompues** : une requête amont interrompue peut n'émettre que de l'usage `assistant/chunk` sans jamais produire d'`assistant/message` final ; ce chunk est conservé. Un message final ultérieur pour le même turn/step le remplace. Si l'amont n'émet aucun événement d'usage, la consommation exacte de tokens ne peut pas être reconstituée à partir du texte de la réponse.
- **Coût estimé** : le coût est une estimation fondée sur les tarifs models.dev et les buckets d'usage de DSH, et non une facture du fournisseur. Les catalogues indisponibles et les modèles sans correspondance restent non tarifés plutôt que de recevoir des tarifs devinés. Les lectures de cache, les écritures de cache et le raisonnement suivent les buckets rapportés par l'événement DSH amont.
- **Prix par paliers** : les entrées models.dev à paliers de contexte choisissent le tarif applicable selon le contexte d'entrée de la requête (entrée fraîche plus tokens de lecture/écriture de cache) ; les barèmes mal formés restent non pris en charge.
- **Frontière des espaces de travail** : seules les sessions dont le cwd correspond à un espace de travail enregistré dans DSH sont prises en compte. Les cwd non enregistrés, y compris des répertoires existants absents du registre, sont ignorés. Le registre est maintenu à jour par une sonde `domain/changed` : toute écriture durable dans le domaine des espaces de travail déclenche une relecture, et seuls les espaces de travail ajoutés ou supprimés sont retraités de façon incrémentale — les espaces inchangés réutilisent leurs agrégats et leur registre calculés. Les données supprimées ou corrompues avant un flush de session réussi ne peuvent pas être récupérées depuis le registre séparé.

### Enregistrement local manuel

1. Placez ce répertoire où vous voulez et créez un lien symbolique vers lui sous $DSH_HOME/profiles/node_modules/ (utilisez une jonction sous Windows) :

   ~~~powershell
   New-Item -ItemType Junction -Path (Join-Path $env:DSH_HOME 'profiles/node_modules/dsh-all-usage') -Target '<absolute plugin path>'
   ~~~

2. Ajoutez cette entrée à $DSH_HOME/profiles/web/cordis.patch.yml :

   ~~~yaml
   - insert:
       - id: all-usage
         name: dsh-all-usage
   ~~~

La couche de correctifs du profil se recharge à chaud ; enregistrez le fichier et rafraîchissez la page.

## Exemples d'utilisation

### Scénarios courants

- Choisissez aujourd'hui, les 7/30/90 derniers jours, tout l'historique ou une plage de dates personnalisée. Combinez les filtres d'espace de travail, de fournisseur et de modèle, utilisez les tendances et les cartes de chaleur pour repérer les changements, examinez les lignes de requête individuelles et exportez en CSV.
- Pour vérifier les estimations de coût, contrôlez d'abord les associations de modèles et l'état des prix, puis examinez les buckets d'entrée, de sortie, de lecture de cache et d'écriture de cache. Les prix sans correspondance ou invérifiables sont affichés comme non tarifés.
- Pour les requêtes échouées ou incomplètes, utilisez les exemples d'événements expurgés ci-dessous. Un enregistrement local signifie que DSH a observé une consommation ; cela ne prouve pas que le fournisseur a facturé la requête.

### Statistiques locales et facturation officielle

Ce plugin produit des statistiques rejouables à partir des journaux d'événements locaux de DSH ; il ne reproduit pas une facture de fournisseur :

- Les statistiques locales lisent les événements DSH `assistant/chunk`, l'`assistant/message` final et les événements de session associés, puis dédupliquent et remplacent les échantillons par `turn / step` logique. La facturation officielle peut appliquer un tokenizer du fournisseur, des règles d'arrondi, des remises, des quotas gratuits et des périodes de facturation.
- Une requête échouée est comptée localement dès qu'elle laisse un chunk d'usage ; la question de savoir si le fournisseur a facturé cette requête échouée doit être vérifiée sur la facture officielle.
- Les prix proviennent du catalogue public models.dev et de surcharges locales explicites. Les prix du catalogue peuvent différer des prix du fournisseur, des tarifs régionaux et des remises sur facture : le champ coût est donc une estimation. Un prix appartient au modèle, si bien que toutes les lignes tarifées à partir du même modèle officiel partagent une seule entrée manuelle ; modifier un prix ne réécrit jamais les coûts positifs existants, tandis qu'un changement de plan de pointe réconcilie l'historique de ce modèle avec la nouvelle politique.
- Les statistiques locales ne couvrent que les espaces de travail enregistrés ; les anciennes lignes de registre liées à des cwd non enregistrés sont exclues. L'usage enregistré pour un **espace de travail supprimé** est conservé et cumulé dans une ligne « Supprimé », de sorte que supprimer un espace de travail ne réduit jamais les totaux historiques. Les totaux peuvent néanmoins être inférieurs à la facture officielle lorsque les journaux sont endommagés, nettoyés ou que l'amont n'émet aucun événement d'usage.

### Exemples d'événements reproductibles

Les exemples suivants sont des cas minimaux expurgés ; les données complètes et exécutables se trouvent dans [`fixtures/usage-events.json`](fixtures/usage-events.json).

#### Conserver le chunk d'une requête échouée

~~~json
[
  {"type": "assistant/chunk", "data": {"turn": 1, "step": 1, "chunk": {"type": "usage", "usage": {"inputTokens": 100, "outputTokens": 20}}}},
  {"type": "request/error", "data": {"code": "upstream-failed"}}
]
~~~

Sans `assistant/message` final, le chunk reste compté comme un appel local ; cela ne signifie pas pour autant que le fournisseur l'a facturé.

#### Chunk d'usage orphelin

~~~json
{"type": "assistant/chunk", "data": {"turn": 1, "step": 1, "chunk": {"type": "usage", "usage": {"inputTokens": 7, "cacheReadTokens": 8}}}}
~~~

Sans request/context ni request/header, les tokens sont quand même comptés, mais l'identité du modèle apparaît comme Unknown ; le plugin ne devine pas un modèle à partir d'un nom de fournisseur ou d'une chaîne d'affichage.

#### Buckets de tokens de cache

~~~json
{"inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 40, "cacheWriteTokens": 5, "reasoningTokens": 3}
~~~

Le total traité localement est de `100 + 20 + 40 + 5 + 3 = 168` ; le coût utilise les buckets input, output, cacheRead et cacheWrite, et le raisonnement n'est pas ajouté une seconde fois à la sortie.

Rejouez la fixture du dépôt :

~~~bash
node scripts/replay-fixture.mjs fixtures/usage-events.json
~~~

La commande charge le véritable hôte du plugin, appelle ses API compatibles, vérifie les totaux de tokens et d'enregistrements documentés, puis affiche un résumé non sensible.

### Sémantique des données, confidentialité et limites

- Les appels et les tokens proviennent des journaux de session de DSH ; `session/flush` ne reconstruit et ne met en file le registre dérivé que lorsque des événements liés sont modifiés (dirty), en fusionnant le dernier enregistrement en attente par session et en vidant la file à la libération du plugin. Les journaux lisibles et l'historique du registre sont remplis à l'activation du plugin, si bien que les données persistées avec succès survivent aux rechargements ou à la suppression d'une session ; supprimer un espace de travail conserve de même son historique, cumulé dans une ligne « Supprimé » avec l'usage qui n'avait pas encore atteint le registre
- Les données de plage au niveau du jour conservent chaque date de session historique lisible disposant d'un usage suivi ; la carte de chaleur est une vue à période commutable (30 derniers jours / 90 jours / 12 mois, 12 mois par défaut), et non une vue fixe des 53 dernières semaines
- Après la suppression d'une session, l'usage correctement vidé est restauré depuis le registre séparé ; les indices de libération et la réconciliation périodique déclenchent des reconstructions sans supprimer de lignes du registre
- Pour chaque session et chaque `turn / step` logique, seule la contribution d'usage finale est conservée ; les nouvelles tentatives ou les messages remplacés ne sont pas comptés deux fois
- Les tokens d'entrée sont frais (hors hits et écritures de cache, qui ont leurs propres buckets) ; les rejeux d'usage entièrement à zéro n'écrasent pas l'usage enregistré et les requêtes en lecture de cache pure restent comptées
- La vérification de version est un unique GET en lecture seule vers `registry.npmjs.org` (uniquement le numéro de version de `dsh-all-usage` : pas de corps, pas de cookies ; émis par l'hôte et mis en cache 6 heures, la page elle-même n'accède jamais au réseau), et un échec dégrade vers « inconnue » au lieu de deviner
- Le point de terminaison de statut léger expose l'instance de l'hôte, la révision des statistiques, la progression de l'analyse, les compteurs de synchronisation, les compteurs de résidence `memory`, `counters` (compteurs d'opérations de diagnostic), `accounting` (cohérence des agrégats du jour) et `mismatch` (premier échantillon d'incohérence de delta entre buckets, ou null), ainsi que le dernier rapport d'environnement client (agent utilisateur, viewport, bande réservée et sa source, rectangles des panneaux — rapportés par un client local et conservés en mémoire uniquement). L'échantillon mismatch porte la clé d'usage interne et l'ID d'espace de travail (une clé d'usage dérive de l'ID de session et peut désigner une session) ; le point de terminaison ne transporte jamais de prompts, de corps de réponse, de chemins d'espace de travail ni de justificatifs ; les instantanés complets ne sont récupérés qu'après un changement de statut ou un rafraîchissement manuel
- Les résultats ciblés gardent les tours, les appels de modèle et les sessions distinctes comme métriques séparées ; une identité de route manquante est explicitement Unknown plutôt que déduite d'un libellé d'affichage
- Le point de terminaison des enregistrements ne renvoie qu'un hash court, l'heure, l'ID d'espace de travail, l'identité structurée du modèle, le turn/step, les buckets de tokens et la source de matérialisation courante. Il omet les ID de session bruts, les chemins, les prompts, les réponses et les justificatifs
- Tokens traités = entrée + sortie + lecture/écriture de cache + raisonnement ; un hit de cache désigne du contexte réutilisé, et non des tokens nouvellement générés ou un coût réel
- Le coût suit la formule à quatre buckets de cc-switch : les tokens d'entrée, de sortie, de lecture de cache et d'écriture de cache sont tarifés séparément, additionnés, puis multipliés par le multiplicateur final ; lorsque le contexte d'entrée dépasse strictement le seuil d'un palier de contexte, les quatre tarifs basculent pour toute la requête au lieu d'un découpage progressif par bandes, et le raisonnement de DSH n'est pas ajouté une seconde fois à la sortie
- La tarification par plage horaire compare les jours de la semaine en UTC à des fenêtres semi-ouvertes : une requête correspondante applique les tarifs de pointe de la règle, tout le reste applique les tarifs de base de la ligne (creux = base) ; l'usage antérieur à l'instant d'entrée en vigueur d'un plan n'a pas de bande vérifiable et échoue en mode fermé comme non tarifé au lieu d'hériter des tarifs du jour, et un plan est partagé par toutes les lignes tarifées à partir de la même entrée (pour DeepSeek, le plan intégré porte la liste officielle des jours fériés du Conseil d'État, actualisée avec les versions du plugin) ; lorsque l'option jours fériés est active, un jour férié légal ne correspond jamais à une plage de pointe et l'instantané de coût enregistre pricingHoliday, de sorte que les enregistrements affichent « jour férié creux » plutôt qu'une bande de creux ordinaire. La table DeepSeek intégrée embarque déjà le calendrier 2026 (actualisé avec les versions du plugin), si bien que les lignes DeepSeek propriétaires ou associées tarifient les jours fériés au tarif creux sans configuration ; les routes de revendeurs restent statiques jusqu'à leur association à l'entrée officielle
- Les coûts de registre hérités portant `tiered` sont migrés vers `unsupported` (`tiered-pricing-not-modeled`) au chargement au lieu de rester faussement marqués comme des estimations actuelles à tarif fixe ; les statistiques de tokens sont inchangées.
- La synchronisation des prix est désactivée par défaut ; lorsque models.dev est indisponible, le dernier catalogue valide reste utilisé et les modèles sans correspondance ne reçoivent jamais de prix par défaut deviné ; les champs de prix des Réglages des coûts constituent le point d'entrée des prix manuels (partagé par toutes les lignes tarifées à partir du même modèle officiel), chaque ligne se déplie en bandes de contexte et en règles de pointe UTC (y compris une tarification creuse optionnelle toute la journée les jours fériés légaux chinois), et la table DeepSeek intégrée peut être copiée pour personnalisation ou restaurée ; les préférences de plage et de vue de détail du tableau de bord sont stockées dans le stockage du navigateur, tandis que l'option de synchronisation toutes les 6 heures est enregistrée immédiatement via l'API de tarification protégée
- Sémantique des associations : une association avec `identityKey` ne s'applique qu'à cette identité de route exacte ; une association sans clé d'identité sert de repli à l'échelle du modèle. Les anciennes valeurs `usageIdentityKey` sont normalisées au chargement.
- Le calendrier des jours fériés n'est récupéré que lorsque l'utilisateur clique sur « Charger depuis le calendrier public » : la requête part vers `cdn.jsdelivr.net` (avec repli sur `raw.githubusercontent.com`), ne transporte que l'année et **n'inclut jamais de données d'usage, de session ou de justificatifs** ; les dates renvoyées restent inertes jusqu'à l'enregistrement, et l'enregistrement les fige avec leur note de source dans le plan de pointe de ce modèle (la source est exclue du hachage de politique)
- Les données de solde proviennent du point de terminaison officiel `/user/balance` de DeepSeek ; la carte affiche une aide lorsqu'aucune clé API n'est configurée
- Le mode anglais utilise UTC pour les buckets de dates, les filtres de plage, les séries, les dates de la carte de chaleur et les horodatages d'export ; le mode chinois utilise l'heure locale
- Le registre affecte chaque ID de session à l'un de 32 répertoires de hachage stable et conserve **un document d'enregistrement par session**, si bien qu'un flush ne publie que ce fichier au lieu de réécrire un fragment ; les anciens fichiers unitaires (y compris l'`all_usage_ledger.json` d'origine) sont supprimés dès qu'il est prouvé que l'arborescence d'enregistrements contient les données, et `DSH_ALL_USAGE_KEEP_LEGACY=1` les conserve. Un échec d'écriture asynchrone ou un arrêt sans flush ne perd pas les statistiques en mémoire ; le démarrage suivant se contente de réanalyser cette session
- Seules les sessions dont le répertoire de travail permet de les rattacher à un espace de travail enregistré sont incluses

## Configuration

| Réglage | Emplacement | Description |
| --- | --- | --- |
| Tarifs et règles des modèles | Tableau de bord « Réglages des coûts » | La synchronisation models.dev est désactivée par défaut ; associez les modèles officiels, définissez des prix manuels, configurez les paliers de contexte, les plages de pointe UTC et les règles de creux des jours fériés légaux chinois. Voir « Sémantique des données » pour les formules et les limites. |
| Alias d'espaces de travail | Barre latérale de DSH ; unité KV `all_usage_aliases` sous `$DSH_HOME/storages` | Remplace les noms d'espaces de travail à l'affichage. |
| Préférences de plage et de détail | Stockage local du navigateur | La plage du tableau de bord et la vue de détail sélectionnées sont enregistrées localement. |
| Marge supérieure Electron | Clé `localStorage` du navigateur `dsh-all-usage:topInset` | Indiquez une valeur en pixels pour ajuster la bande réservée ; `0` la désactive. Rafraîchissez pour appliquer. |
| Conserver les anciens fragments de registre | Variable d'environnement de l'hôte `DSH_ALL_USAGE_KEEP_LEGACY=1` | Les anciens fichiers de fragments entiers sont supprimés une fois l'arborescence d'enregistrements par session confirmée ; mettez `1` pour les conserver. |
| Budget de lignes de détail résidentes | Variable d'environnement de l'hôte `DSH_ALL_USAGE_RESIDENT_ROWS` | Lignes, 12 000 par défaut ; une valeur finie est arrondie vers le bas (Math.floor). Une valeur négative garde toutes les lignes de détail résidentes ; `0` libère toutes les lignes évincables dès qu'une analyse se termine ; une valeur non numérique revient à la valeur par défaut. Il s'agit d'un budget souple : les lignes dont le prix n'est pas fixé, ainsi que les lignes d'une session en cours d'écriture, de lecture, de resynchronisation ou de préchargement, ne sont jamais libérées. |
| Limite de cache des enregistrements de session | Variable d'environnement de l'hôte `DSH_ALL_USAGE_RECORD_CACHE_MB` | Mio, 16 par défaut. Seule une valeur finie ≥ 0 est acceptée ; une valeur négative ou non numérique revient à 16. `0` n'évince que les enregistrements propres évincables, jusqu'au plus récent, si bien que des enregistrements protégés peuvent porter la résidence réelle au-delà du budget. Il s'agit d'un budget souple : un enregistrement modifié, en attente, en écriture, en resynchronisation, en préchargement ou en lecture n'est jamais évincé, et un stockage de registre incapable de relire un enregistrement garde tous les enregistrements résidents. La résidence est estimée à partir du nombre de lignes d'usage (et non d'une allocation mesurée) ; voir `recordCacheMB` dans le statut. |

## API et CLI

### CLI

Le plugin n'a pas de CLI d'exécution séparée. La commande d'installation officielle se trouve dans Démarrage rapide ; les commandes de développement et de test sont listées ci-dessous.

### API HTTP

- `GET /api/all-usage` — instantané d'usage compatible
- `GET /api/all-usage/status` — révision légère et santé de la synchronisation, plus le dernier rapport d'environnement client (`clientEnv`), la version du plugin en cours d'exécution (`pluginVersion`) et un identifiant dérivé de la capacité d'écriture (`capabilityId`, qui change lorsque la capacité tourne afin que la page puisse détecter un rechargement du plugin ; la capacité elle-même n'est jamais envoyée que dans l'instantané complet), ainsi que les compteurs de résidence `memory` : `residentRows` (lignes de détail d'usage résidentes), `residentRecords` (enregistrements de session résidents), `recordCacheMB` (taille du cache d'enregistrements de session en Mio à une décimale ; une estimation dérivée du nombre de lignes d'usage plutôt qu'une allocation mesurée), `sessions` (agrégats de session), `recordsCache` (statistiques du cache de requêtes d'enregistrements) et `heapUsedMB` / `rssMB` (qui appartiennent tous deux au processus hôte entier, pas au seul plugin). La même réponse porte `counters` (compteurs d'opérations de diagnostic), `accounting` (cohérence des agrégats du jour) et `mismatch` (premier échantillon d'incohérence de delta entre buckets, ou null)
- `GET /api/all-usage/query` — agrégat ciblé, tendance journalière/horaire et données de carte de chaleur ; les portées d'un seul jour remplissent `hourly`, tandis que les portées multi-jours renvoient un tableau `hourly` vide
- `GET /api/all-usage/records` — lignes d'usage canoniques paginées et sûres pour la vie privée
- `POST /api/all-usage/archive` — replie les enregistrements de session plus anciens que `days` jours (90 par défaut, entier de 1 à 3650) dans `<root>/archive/<YYYY-MM>.jsonl.gz`, puis supprime leurs documents d'arborescence une fois les fichiers mensuels durables ; par défaut, seule une simulation est produite (`dryRun: true`) et seul un `dryRun: false` explicite écrit ; il prend le même verrou de maintenance que la migration et la CLI, répond `{ ok, months, archived, bytes, compressed, dryRun, errors }` et renvoie 409 lorsque le verrou est détenu. Exige la même capacité d'écriture locale que l'enregistrement des prix
- `GET /api/all-usage/icon?key=<brand key>` — sert une marque à la demande (SVG avec un cache long et un ETag) ; le bundle client ne transporte que les métadonnées de résolution, si bien qu'ajouter une marque ne le fait plus grossir
- `GET /api/all-usage/version?force=1` — vérification de version : la version en cours, la dernière version publiée, le verdict (`latest` / `outdated` / `unknown`), la date de la vérification et sa provenance ; mise en cache sur l'hôte pendant 6 heures avec au plus une requête amont toutes les 30 secondes par processus (le plancher s'applique aussi à `force=1`), `force=1` venant du bouton de rafraîchissement
- `GET /api/all-usage/balance?force=1` — solde du compte via la clé API `llm-deepseek` configurée
- `POST /api/all-usage/alias` — mise à jour des alias d'espaces de travail
- `GET /api/all-usage/pricing` — lecture de la table de prix modifiable complète : tarifs effectifs et statut par ligne, associations, prix manuels, plans de pointe (avec leur origine intégrée ou explicite et leurs règles complètes) et lignes qui n'existent que dans la configuration
- `GET /api/all-usage/pricing/models?q=...` — recherche dans les ID et noms d'affichage des modèles officiels, y compris les tarifs de prévisualisation, les indicateurs de tarification par paliers et l'existence d'une table de pointe intégrée
- `POST /api/all-usage/pricing` — enregistrement de la synchronisation, des associations, des prix manuels, des bandes de tarifs par contexte et des règles de plages de pointe (forme de requête inchangée)
- `POST /api/all-usage/pricing/sync` — synchronisation de models.dev et rattrapage des appels non tarifés
- `POST /api/all-usage/pricing/holidays` — récupère un an du calendrier des jours fériés chinois (jeu de données holiday-cn, jsDelivr d'abord avec repli sur GitHub raw, mis en cache côté hôte pendant 24 heures) et ne renvoie que la liste des jours de repos et sa source ; **rien n'est écrit dans la configuration** — le client fige les dates dans un plan de pointe
- `GET /api/all-usage/client-env` — rapport d'environnement client (agent utilisateur, hauteur de l'overlay des contrôles de fenêtre, bande réservée **et sa source**, viewport, rectangles des panneaux) ; le client le transmet au chargement et à chaque ouverture de la feuille, conservé en mémoire uniquement

## Développement et tests

- Après avoir modifié `src/client.js`, exécutez `npm run build:client`, rechargez le module client de DSH et rafraîchissez la page ; `lib/client.js` est généré et ne doit pas être modifié directement. Après avoir modifié `lib/plugin.js` ou un autre module de l'hôte, rechargez le paquet via DSH ou redémarrez le processus
- Le plugin n'a aucune dépendance d'exécution tierce : l'hôte utilise les services Cordis et le client utilise le module React fourni par la runtime ; Terser figé n'est qu'une dépendance de développement pour générer l'artefact navigateur
- Les publications manuelles de reprise npm exigent un tag `v<package.version>` cible et le SHA complet du commit ; GitHub Actions vérifie les deux par rapport au tag extrait et à la version du paquet. Les événements de publication effectuent le même contrôle de commit.

### Vérifications locales

~~~bash
npm test
npm run fixture:check
npm run build:client
npm run check:pack
~~~

## État et mises à jour

La dernière version publiée est `v1.2.3` ([GitHub Release](https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.2.3) | npm : `npm i dsh-all-usage@1.2.3`). Voir [CHANGELOG.md](CHANGELOG.md) pour l'historique complet du développement et des versions.

### Dernière version publiée : v1.2.3

- **Quatre corrections d'affichage** : la barre la plus à gauche ne recouvre plus les graduations de l'axe des valeurs, les libellés des jours de la carte de chaleur se réalignent sur leurs lignes, les infobulles ne sont plus rognées par le panneau, et les graphiques comme le calendrier restent lisibles en thème clair.
- **Le panneau devient une carte flottante aux coins arrondis** : coins de 24 px et marge sur les quatre côtés, les fenêtres étroites ne retombent plus sur des angles droits.
- **La barre de titre forme sa propre carte arrondie** : sa bordure inférieure devient une ombre douce et elle reste sous la poignée de déplacement pendant le défilement.

Voir [CHANGELOG.md](CHANGELOG.md) pour l'historique complet des versions.

## Contribution et contact

Utilisez les modèles ci-dessous pour signaler des bugs. Pour les questions générales ou les discussions sur les fonctionnalités, consultez le [dépôt du projet](https://github.com/ParticleLight/dsh-all-usage). Les pull requests sont les bienvenues ; un rapport de bug doit préciser les versions de DSH, de Node.js et du plugin.

- [Incohérence des données](.github/ISSUE_TEMPLATE/data-inconsistency.md)
- [Échec de démarrage du plugin](.github/ISSUE_TEMPLATE/startup-failure.md)
- [Problème de calcul des coûts](.github/ISSUE_TEMPLATE/cost-calculation.md)

## Licence

MIT

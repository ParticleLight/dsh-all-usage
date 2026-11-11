# dsh-all-usage

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-all-usage?label=npm&color=4D6BFE)](https://www.npmjs.com/package/dsh-all-usage)
[![downloads](https://img.shields.io/npm/dt/dsh-all-usage?label=downloads&color=4D6BFE)](https://www.npmjs.com/package/dsh-all-usage)
[![stars](https://img.shields.io/github/stars/ParticleLight/dsh-all-usage?label=stars&logo=github)](https://github.com/ParticleLight/dsh-all-usage/stargazers)
[![license](https://img.shields.io/github/license/ParticleLight/dsh-all-usage?label=license&color=green)](LICENSE)
[![CI](https://github.com/ParticleLight/dsh-all-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/ParticleLight/dsh-all-usage/actions/workflows/ci.yml)
[![DSH runtime compatibility](https://img.shields.io/badge/DSH%20runtime-11%20verified-4D6BFE)](#kompatibilität-und-bekannte-einschränkungen)
[![status](https://img.shields.io/badge/status-stable-brightgreen)](https://github.com/ParticleLight/dsh-all-usage/releases)

[中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

## Einleitung

Ein vollständiges Nutzungs-Dashboard für DeepSeek Harness. Analysiert Token, Cache-Verhalten, geschätzte Kosten, Kontostand und Aktivität nach Modell, Anbieter, Workspace und Zeitraum.

Für DSH-Nutzer, die Token-Verbrauch, Modellkosten und Workspace-Aktivität anhand lokaler Sitzungsdaten prüfen müssen.

## Schnellstart

~~~bash
dsh plugin --profile web add github:ParticleLight/dsh-all-usage
~~~

Der Installationsbefehl stellt das Bundle zusammen. In der Regel genügt ein Neuladen der Browserseite, um den Client zu laden; manuelle Änderungen am Profil sind nicht nötig. Falls Ihre DSH-Version neu installierte Pakete nicht dynamisch zusammensetzt, verwenden Sie das von ihr unterstützte Neuladen der Pakete oder einen Neustart, laden Sie anschließend die Seite neu und öffnen Sie das Dashboard über die DSH-Seitenleiste.

## Kernfunktionen

- **Nutzung über mehrere Dimensionen erkunden**: Zusammenfassungen, Trends, Heatmaps und paginierte Anfrageprotokolle prüfen; Datums-, Workspace-, Anbieter- und Modellfilter kombinieren und die aktuelle Ansicht anschließend als CSV exportieren.
- **Modelle und Workspaces verstehen**: Ansichten für gemischte Modelle, zusammengeführte Modelle und Anbieter vergleichen, mit Streaks, Workspace-Verteilungen und täglichen Turn-Details; 43 Markenlogos sind integriert, und unbekannte Modellidentitäten bleiben neutral.
- **Kosten und Guthaben konfigurieren**: Kosten über vier Token-Buckets schätzen, offizielle Modelle zuordnen oder manuelle Preise setzen, Kontext-Stufen und Peak-Zeitfenster konfigurieren und den Kontostand abfragen; siehe Konfiguration unten.
- **Die vollständige Historie inkrementell synchronisieren**: lesbare Sitzungen scannen, unveränderte Ledger-Daten pro Sitzung über persistierte Revisionen wiederverwenden, nur geänderte Logs lesen und Änderungen an der DSH-Workspace-Registry folgen.
- **Den Routinebetrieb prüfen**: Scan-Zustand, Lesezugriffe, Ledger-Wiederherstellungen und Fehler einsehen; die Oberflächensprache wechseln, Workspace-Aliase verwalten und die laufende Plugin-Version prüfen.

## Rundgang durch die Oberfläche

Diese Screenshots wurden am 2026-11-11 aus einer laufenden Installation aufgenommen (Host 1.2.3 mit dem Client 1.2.4): chinesische und englische Oberfläche, dunkles Theme. Die gezeigten Nutzungs- und Workspace-Daten gehören zu dieser Aufnahmeumgebung.

### Dashboard-Übersicht

Der Kopfbereich enthält den Versionsstatus und die Werkzeuge (Workspace-Aliase, Kosteneinstellungen, Wartung, Oberflächensprache); darunter stehen der Zeitraum (Heute / Letzte 7 Tage / Letzte 30 Tage / Letzte 90 Tage / Dieser Monat / Gesamter Zeitraum / Benutzerdefiniert) sowie die Filter für Workspace, Anbieter und Modell. Die Hauptkarte zeigt die Token-Summe, die Anzahl der Anfragen und die geschätzten Kosten für den Zeitraum, gefolgt von Kontostand, Gesamtnutzungen, aktueller Streak, Workspace-Verteilung und Cache-Trefferquote.

![Dashboard-Übersicht](assets/screenshots/en/01-overview.png)

### Nutzungsverlauf

Ein Tagesverlauf als Linien- oder Balkendiagramm; ein Klick auf einen Datenpunkt zeigt den jeweiligen Tag. Lange Zeiträume werden auf Drei-Tages-Punkte und danach auf Wochen, Monate, Quartale oder Jahre heruntergerechnet, mit höchstens 180 Punkten pro Diagramm.

![Nutzungsverlauf (Linie)](assets/screenshots/en/02-trend.png)

Auf Balken umgeschaltet zeigt sich dieselbe Datenlage Tag für Tag, mit derselben Hover-Karte und demselben Tagesdetail.

![Nutzungsverlauf (Balken)](assets/screenshots/en/02-trend-bars.png)

### Nutzungs-Heatmap

Drei Zeiträume — 30 Tage, 90 Tage und 12 Monate —, bei denen die Wochentage je Zeile ausgerichtet sind und die Farbtiefe das Token-Volumen jedes Tages zeigt.

![Nutzungs-Heatmap](assets/screenshots/en/03-heatmap.png)

### Modell- und Workspace-Statistiken

Der Detailbereich bietet Anfrageprotokolle, Modellstatistiken und Workspace-Statistiken. Modellstatistiken lassen sich nach kombinierter Ansicht, nach Modell oder nach Anbieter zusammenfassen, mit Aufrufen, Input, Cache-Treffern, Output, Reasoning, Gesamt, Kosten und Trefferquote pro Zeile; Workspace-Statistiken aggregieren pro Workspace und berücksichtigen Ihre Aliase.

![Modellstatistiken](assets/screenshots/en/04-model-stats.png)

### Anfrageprotokolle

Jede Anfrage ist mit Modell, Token und Kosten aufgelistet, die neueste zuerst, und die aktuell gefilterte Ansicht lässt sich als CSV exportieren; Prüfzähler wie Revisions-Wiederverwendung, Lesezugriffe und Ledger-Wiederherstellungen stehen in der Sync-Zeile oben auf der Seite.

![Anfrageprotokolle](assets/screenshots/en/05-request-logs.png)

### Kosteneinstellungen

Die Kosten werden über vier Token-Buckets geschätzt: Zuordnung offizieller Modelle, manuelle Preise, Kontext-Stufen und Peak-Zeitfenster, dazu eine Abfrage des Kontostands.

![Kosteneinstellungen](assets/screenshots/en/06-cost-settings.png)

### Wartung

Sitzungen, die sich eine Weile nicht geändert haben, werden in monatliche komprimierte Dateien überführt: zuerst die betroffenen Datensätze, die Größe und die Monate in der Vorschau prüfen und erst dann ausführen; archivierte Datensätze bleiben lesbar und zählbar.

![Wartung](assets/screenshots/en/07-maintenance.png)

## Technologie-Stack und Architektur

- **Host** (Einstieg `lib/index.js`, zusammengesetzt durch `lib/plugin.js`): nach Zuständigkeit aufgeteilt auf `aggregation.js` (Aggregation/Query), `ledger.js` (persistentes Ledger), `session-sync.js` (Verlaufs-/Live-Sync), `pricing-runtime.js` (Laufzeit-Preise), `balance.js` (Guthaben) und `http.js` (geschützte Routen); aggregiert `turn/end`, `assistant/chunk`-Usage und die finale `assistant/message.usage`, faltet Live-Updates aus `session/event` ein und stellt Datenrouten über `webServer` bereit.
- **Client**: Der lesbare Quellcode liegt in `src/client.js`; `npm run build:client` erzeugt mit der festgepinnten Terser-Version das `window.__ModuleLoader__`-Bundle unter `lib/client.js`, das den Seitenleisten-Eintrag „Nutzungsstatistik“ über den Slot `sidebar.footer.action` registriert. Alle API-Routen akzeptieren Loopback-Anfragen und lehnen einen expliziten Cross-Origin-`Origin` ab; Guthaben-Lesezugriffe und Alias-Schreibzugriffe benötigen zusätzlich ein prozessgebundenes Token, das beim Start des Plugins erzeugt wird (das Guthaben-GET toleriert Browser, die `Origin` weglassen). **Schreibzugriffe werden durch dieses Token autorisiert, nicht durch einen Origin**: Die DSH-Desktop-Shell führt die UI unter ihrem eigenen Schema aus und leitet Anfragen über Electron weiter, das `Origin` (zusammen mit `Host`/`Cookie`/`Sec-Fetch-*`) entfernt, sodass eine Origin-Pflicht jedes Speichern im Desktop mit 403 scheitern ließ. Ein vorhandener `Origin` muss weiterhin Loopback oder das eigene Schema der Shell sein, und `Host` muss weiterhin Loopback sein (DNS-Rebinding-Schutz).

![Systemarchitekturdiagramm von All Usage](assets/readme-architecture-en.svg)

### Verlaufs- und Live-Datenfluss

![Wiederverwendung von Verlaufsrevisionen und Live-Schreibfluss des Ledger pro Sitzung](assets/readme-sync-en.svg)

### Speicherung und Performance

- **Ein Datensatz pro Sitzung**: Das Ledger schreibt jede Sitzung als eigenes Dokument (stabil gehasht in 32 Verzeichnisse), sodass ein Update genau eine Datei veröffentlicht. Auf denselben Daten gemessen: Ein einzelnes Update ging vom Neuschreiben eines 13,27 MB großen Shards (273 ms) zum Schreiben eines Datensatzes (Median 4,6 ms).
- **Eine Identität pro Route**: Usage-Einträge referenzieren die Routenidentität und ihre Preisdefinition, statt sie zu wiederholen, sodass 1059 Datensätze von **91,3 auf 74,7 MB (-18 %)** schrumpften
- **Der Snapshot zahlt nur für eine Zeitzone**: `GET /api/all-usage?utc=0|1` liefert einen einzigen Kalender (früher teilten beide Kopien die Payload in zwei Hälften), und ein Tag behält seine Sitzungs-ID-Details für die letzten **180 Tage**, während ältere Tage Zähler und Aggregate behalten
- **Das Trenddiagramm ist auf 180 Punkte begrenzt**: Ab einem halben Jahr fällt es auf drei Tage pro Punkt und weitet sich auf Woche / Monat / Quartal / Jahr, sodass das Diagramm nicht mit der Historie wachsen kann
- **Budgets stehen im Code**: 20 Query- und 20 Datensatz-Cache-Einträge, 5000 Preisauflösungen, 512 Kontext-Einträge pro Sitzung, 500 Preiszeilen, 32 Shards, 180 Trendpunkte und ein 180-Tage-Fenster für Sitzungs-IDs - abgesichert durch `test/perf-budgets.test.js`, sodass eine Lockerung bedeutet, diese Tabelle zu bearbeiten
- **Reproduzierbare Benchmarks**: `node bench/ledger.mjs` (Ledger-Größe und Rewrite-Kosten pro Update), `node bench/ledger-layout.mjs` (die beiden Speicherlayouts, auf Kopien echter Shards) `node bench/endpoints.mjs` (Median-Latenz und Payload von fünf Lese-Endpunkten) und `node scripts/dead-code.mjs` (Exporte, auf die nichts verweist, Client-Helfer, die niemand aufruft, Stylesheet-Klassen, die kein Markup rendern kann)

## Installation

Dies ist ein Standard-Plugin-Paket der DSH-Community mit `dsh.bundle`-Manifest und Web-Client. Es liest persistierte Sitzungslogs und ein separates Nutzungs-Ledger und füllt die Historie bei der Aktivierung nach.

### Kompatibilität und bekannte Einschränkungen

- **Laufzeit**: Node.js `>=22 <25` ist erforderlich. Die CI führt die Testsuite, Syntaxprüfungen und Prüfungen des Paketinhalts auf Node 22 und Node 24 aus.
- **DSH-Kompatibilität**: `package.json` deklariert DSH-Runtime `>=0.1.1-rc.1 <0.1.5-0 || >=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.2 <0.1.8-0 || >=0.2.0-rc.2 <0.2.1-0 || 0.2.1-alpha.2 || 0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.2-alpha.3 || 0.2.2-rc.1`; die echte Cordis-Servicekette ist lokal auf `0.2.1-rc.1` und `0.2.1-rc.2` verifiziert (strikter Smoke auf Node 24; beide heben Cordis auf die stabile Paarung 4.0.5 / loader 1.0.6 / timer 1.1.7), `0.2.1-alpha.2`, `0.2.0-rc.2`, `0.1.7-rc.2`, `0.1.5-rc.2`, `0.1.5-rc.1`, `0.1.1-rc.2` und `0.1.1-rc.1`. Jede deklarierte Runtime steht in der CI-Smoke-Matrix auf Node 22 und 24, aber die beiden `0.2.1`-Linien werden als SKIPPED — nicht als bestanden — gemeldet, weil Upstream nie die passende Version von `@deepseek-ai/dsh-invariants` veröffentlicht hat. `0.1.2-rc.1` wurde außerdem durch realen Einsatz als kompatibel verifiziert, ist aber nicht von der CI-Smoke-Matrix abgedeckt. Die Deklaration ist pro Tupel aufgeteilt statt als ein Intervall geschrieben, weil node-semver eine Prerelease-Version nur zulässt, wenn ein Comparator dasselbe exakte `major.minor.patch`-Tupel teilt und selbst ein Prerelease-Tag trägt — `0.2.0-rc.2` wird nur akzeptiert, weil der Bereich `>=0.2.0-rc.2` sagt.
- **Desktop-Client (Electron, Windows)**: Das Plugin ist im Betrieb im DSH-Desktop-Client verifiziert (`@deepseek-ai/dsh-desktop` `0.1.7-rc.2` gemessen). Der Desktop-Client hält oben im Fenster einen 40px hohen Caption-Streifen für seine eigenen Minimieren-/Maximieren-/Schließen-Schaltflächen und markiert das Dokument mit `data-windows-titlebar` und `--dsh-windows-titlebar-height`; das Panel zeichnet **unterhalb** dieses Streifens, sodass die Schließen-Schaltfläche des Clients nie verdeckt wird. Browser tragen keine solche Markierung und reservieren nichts. Die Streifenhöhe kommt zuerst aus der Deklaration des Hosts, dann aus dem Rectangle des Window Controls Overlay, dann aus dem User-Agent; zum Anpassen führen Sie `localStorage.setItem('dsh-all-usage:topInset', '48')` in den DevTools aus und laden neu (`0` reserviert nichts) — kein Rebuild nötig. Der Desktop-Client bringt seine eigene Runtime mit; die dort gemessene Version `0.1.7-rc.2` ist Teil des deklarierten Bereichs und der CI-Smoke-Matrix unten.
- **Web-Service-Abhängigkeit**: Der Host deklariert `webServer` als erforderliche Abhängigkeit, sodass DSH auf einen spät eingehängten Service wartet, bevor es das Plugin anwendet; dieses Paket zielt auf das DSH-Web-Profil und stellt ohne WebServer keine Routen bereit. Der HTTP-Guard prüft außerdem den tatsächlichen Socket-Peer, sodass ein Reverse-Proxy nur akzeptiert wird, wenn die Verbindung selbst Loopback ist.
- **Oberflächensprache**: Beim ersten Aufruf folgt das Panel der **Language**-Einstellung von DSH (`Settings → General → Language`, gelesen über den `locale`-Service des Hosts); ohne diesen Service fällt es auf die Browsersprache und dann auf Englisch zurück. Sobald im Panel eine Sprache gewählt wurde, gewinnt die Wahl des Panels und die Host-Einstellung überschreibt sie nicht mehr. Die Sprache entscheidet auch über die Zeitzone — Chinesisch nutzt die lokale Zeit, Englisch UTC —, sodass ein Wechsel den passenden Snapshot neu lädt.

| DSH-Runtime | Node.js-Unterstützung | Echter Cordis-Smoke | Ergebnis |
| --- | --- | --- | --- |
| `0.2.2-rc.1` | `>=22 <25` | Bestanden (strikter echter Cordis-Smoke lokal auf Node 24 verifiziert; stabile Cordis 4.1.0 / loader 1.1.0 / timer 1.2.0) | Deklariert und verifiziert (nur genau dieses rc; die CI meldet SKIPPED, weil Upstream `dsh-invariants@0.2.2-rc.1` nie veröffentlicht hat) |
| `0.2.2-alpha.3` | `>=22 <25` | Bestanden (strikter echter Cordis-Smoke lokal auf Node 24 verifiziert; Prerelease Cordis 4.0.6-alpha.2 / loader 1.0.7-alpha.2 / timer 1.1.8-alpha.2) | Deklariert und verifiziert (nur genau dieses alpha.3; keine anderen alpha-Versionen impliziert; die CI meldet SKIPPED, weil Upstream `dsh-invariants@0.2.2-alpha.3` nie veröffentlicht hat) |
| `0.2.1-rc.2` | `>=22 <25` | Bestanden (strikter echter Cordis-Smoke lokal auf Node 24 verifiziert; stabile Cordis 4.0.5 / loader 1.0.6 / timer 1.1.7) | Deklariert und verifiziert (nur genau dieses rc; die CI meldet SKIPPED, weil Upstream `dsh-invariants@0.2.1-rc.2` nie veröffentlicht hat) |
| `0.2.1-rc.1` | `>=22 <25` | Bestanden (strikter echter Cordis-Smoke lokal auf Node 24 verifiziert; stabile Cordis 4.0.5 / loader 1.0.6 / timer 1.1.7) | Deklariert und verifiziert (nur genau dieses rc; keine anderen rc-Versionen impliziert; die CI meldet SKIPPED, weil Upstream `dsh-invariants@0.2.1-rc.1` nie veröffentlicht hat) |
| `0.2.1-alpha.2` | `>=22 <25` | Bestanden (strikter echter Cordis-Smoke lokal auf Node 24 verifiziert; die CI meldet SKIPPED, weil Upstream `dsh-invariants@0.2.1-alpha.2` nie veröffentlicht hat) | Deklariert und verifiziert (nur genau dieses alpha.2; keine anderen alpha-Versionen impliziert) |
| `0.2.0-rc.2` | `>=22 <25`, CI deckt 22/24 ab | Bestanden (echte Cordis-Servicekette, CI deckt Node 22/24 ab) | Deklariert und verifiziert (historisch verifiziert; CI deckt Node 22/24 ab) |
| `0.1.7-rc.2` | `>=22 <25`, CI deckt 22/24 ab | Bestanden (echte Cordis-Servicekette, CI deckt Node 22/24 ab) | Deklariert und verifiziert (historisch verifiziert; CI deckt Node 22/24 ab) |
| `0.1.5-rc.2` | `>=22 <25`, CI deckt 22/24 ab | Bestanden (echte Cordis-Servicekette, CI deckt Node 22/24 ab) | Deklariert und verifiziert |
| `0.1.5-rc.1` | `>=22 <25`, CI deckt 22/24 ab | Bestanden (echte Cordis-Servicekette, CI deckt Node 22/24 ab) | Deklariert und verifiziert |
| `0.1.2-rc.1` | `>=22 <25` | Durch realen Einsatz bestanden (nicht in der CI) | Im realen Einsatz als kompatibel verifiziert |
| `0.1.1-rc.2` | `>=22 <25`, CI deckt 22/24 ab | Bestanden (echte Cordis-Servicekette, CI deckt Node 22/24 ab) | Deklariert und verifiziert |
| `0.1.1-rc.1` | `>=22 <25`, CI deckt 22/24 ab | Bestanden (echte Cordis-Servicekette, CI deckt Node 22/24 ab) | Deklariert und verifiziert |
| Andere Versionen | `>=22 <25` | Nicht getestet | Außerhalb der verifizierten Matrix |

Eine nicht gelistete DSH-Version ist nicht zwangsläufig inkompatibel. Bitte geben Sie beim Melden eines Problems die Versionen von DSH, Node.js und Plugin an.

- **Unterbrochene Anfragen**: Eine unterbrochene Upstream-Anfrage kann nur `assistant/chunk`-Usage ausgeben und nie eine finale `assistant/message` erzeugen; dieser Chunk bleibt erhalten. Eine spätere finale Nachricht für denselben Turn/Step ersetzt ihn. Wenn der Upstream überhaupt kein Usage-Ereignis ausgibt, lässt sich der exakte Token-Verbrauch nicht aus dem Antworttext rekonstruieren.
- **Geschätzte Kosten**: Kosten sind eine Schätzung auf Basis der models.dev-Tarife und der DSH-Usage-Buckets, keine Anbieter-Rechnung. Nicht verfügbare Kataloge und nicht zugeordnete Modelle bleiben ohne Preis, statt geratene Tarife zu erhalten. Cache-Reads, Cache-Writes und Reasoning folgen den Buckets, die das Upstream-DSH-Ereignis meldet.
- **Gestufte Preise**: Kontextgestufte Einträge von models.dev wählen den passenden Tarif anhand des Eingabekontexts der Anfrage (frischer Input plus Cache-Read/Write-Token); fehlerhafte Zeitpläne bleiben nicht unterstützt.
- **Workspace-Grenze**: Nur Sitzungen, deren cwd auf einen bei DSH registrierten Workspace abbildet, werden einbezogen. Nicht registrierte cwds, einschließlich existierender Verzeichnisse, die in der Registry fehlen, werden ignoriert. Die Registry wird durch eine `domain/changed`-Sonde frisch gehalten: Jeder persistente Schreibzugriff auf die Workspace-Domain löst ein erneutes Einlesen aus, und nur hinzugefügte oder entfernte Workspaces werden inkrementell neu verarbeitet — unveränderte Workspaces verwenden ihre berechneten Aggregate und ihr Ledger weiter. Daten, die vor einem erfolgreichen Session-Flush gelöscht oder beschädigt wurden, lassen sich aus dem separaten Ledger nicht wiederherstellen.

### Manuelle lokale Registrierung

1. Legen Sie dieses Verzeichnis an einer beliebigen Stelle ab und erstellen Sie einen symbolischen Link darauf unter $DSH_HOME/profiles/node_modules/ (unter Windows eine Junction):

   ~~~powershell
   New-Item -ItemType Junction -Path (Join-Path $env:DSH_HOME 'profiles/node_modules/dsh-all-usage') -Target '<absolute plugin path>'
   ~~~

2. Fügen Sie diesen Eintrag zu $DSH_HOME/profiles/web/cordis.patch.yml hinzu:

   ~~~yaml
   - insert:
       - id: all-usage
         name: dsh-all-usage
   ~~~

Die Patch-Ebene des Profils lädt per Hot-Reload neu; speichern Sie die Datei und laden Sie die Seite neu.

## Anwendungsbeispiele

### Typische Szenarien

- Wählen Sie heute, die letzten 7/30/90 Tage, die gesamte Historie oder einen benutzerdefinierten Zeitraum. Kombinieren Sie Workspace-, Anbieter- und Modellfilter, nutzen Sie Trends und Heatmaps, um Veränderungen zu finden, prüfen Sie einzelne Anfragezeilen und exportieren Sie CSV.
- Um Kostenschätzungen zu prüfen, sehen Sie zuerst Modellzuordnungen und Preisstatus an und untersuchen dann die Buckets für Input, Output, Cache-Read und Cache-Write. Nicht zugeordnete oder nicht verifizierbare Preise werden als „nicht bepreist“ angezeigt.
- Für fehlgeschlagene oder unvollständige Anfragen nutzen Sie die redigierten Ereignisbeispiele unten. Ein lokaler Datensatz bedeutet, dass DSH Usage beobachtet hat; er beweist nicht, dass der Anbieter die Anfrage abgerechnet hat.

### Lokale Statistiken vs. offizielle Abrechnung

Dieses Plugin meldet wiederholbare Statistiken aus lokalen DSH-Ereignislogs; es ist kein Abbild einer Anbieter-Rechnung:

- Lokale Statistiken lesen DSH `assistant/chunk`, finale `assistant/message` und zugehörige Sitzungsereignisse und deduplizieren bzw. ersetzen Stichproben nach logischem `turn / step`. Die offizielle Abrechnung kann einen Anbieter-Tokenizer, Rundungsregeln, Rabatte, Freikontingente und Abrechnungszeiträume verwenden.
- Eine fehlgeschlagene Anfrage wird lokal einbezogen, sobald sie einen Usage-Chunk hinterlässt; ob der Anbieter diese fehlgeschlagene Anfrage berechnet hat, muss anhand der offiziellen Rechnung geprüft werden.
- Preise stammen aus dem öffentlichen models.dev-Katalog und lokalen expliziten Overrides. Katalogpreise können von Anbieterpreisen, regionalen Tarifen und Rechnungsrabatten abweichen, daher ist das Kostenfeld eine Schätzung. Ein Preis gehört zum Modell, also teilen sich alle Zeilen, die aus demselben offiziellen Modell bepreist werden, einen manuellen Eintrag; Preisänderungen schreiben nie bestehende positive Kosten um, während eine Änderung des Peak-Plans die Historie dieses Modells gegen die neue Richtlinie abgleicht.
- Lokale Statistiken umfassen nur registrierte Workspaces; alte Ledger-Zeilen für nicht registrierte cwds werden ausgeschlossen. Usage, die für einen **gelöschten Workspace** erfasst wurde, bleibt erhalten und wird in einer Zeile „Gelöscht“ summiert, sodass das Entfernen eines Workspace historische Summen nie verkleinert. Die Summen können trotzdem unter der offiziellen Rechnung liegen, wenn Logs beschädigt oder bereinigt wurden oder der Upstream kein Usage-Ereignis ausgibt.

### Reproduzierbare Ereignisbeispiele

Die folgenden Beispiele sind redigierte Minimalbeispiele; die vollständigen lauffähigen Daten stehen in [`fixtures/usage-events.json`](fixtures/usage-events.json).

#### Beibehalten eines fehlgeschlagenen Anfrage-Chunks

~~~json
[
  {"type": "assistant/chunk", "data": {"turn": 1, "step": 1, "chunk": {"type": "usage", "usage": {"inputTokens": 100, "outputTokens": 20}}}},
  {"type": "request/error", "data": {"code": "upstream-failed"}}
]
~~~

Ohne finale `assistant/message` bleibt der Chunk ein lokaler Aufruf; das bedeutet nicht, dass der Anbieter ihn zwangsläufig berechnet hat.

#### Verwaister Usage-Chunk

~~~json
{"type": "assistant/chunk", "data": {"turn": 1, "step": 1, "chunk": {"type": "usage", "usage": {"inputTokens": 7, "cacheReadTokens": 8}}}}
~~~

Ohne request/context oder request/header werden Token weiterhin gezählt, aber die Modellidentität wird als Unknown angezeigt; das Plugin rät kein Modell aus einem Anbieternamen oder Anzeigestring.

#### Cache-Token-Buckets

~~~json
{"inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 40, "cacheWriteTokens": 5, "reasoningTokens": 3}
~~~

Die lokal verarbeitete Summe ist `100 + 20 + 40 + 5 + 3 = 168`; die Kosten nutzen die Buckets input, output, cacheRead und cacheWrite, und Reasoning wird nicht erneut zum Output addiert.

Spielen Sie das Repository-Fixture erneut ab:

~~~bash
node scripts/replay-fixture.mjs fixtures/usage-events.json
~~~

Der Befehl lädt den echten Plugin-Host, ruft seine kompatiblen APIs auf, prüft die dokumentierten Token- und Datensatzsummen und gibt eine nicht sensible Zusammenfassung aus.

### Datensemantik, Datenschutz und Grenzen

- Aufrufe und Token stammen aus DSH-Sitzungslogs; `session/flush` baut das abgeleitete Ledger nur dann neu auf und stellt es in die Warteschlange, wenn zugehörige Ereignisse geändert sind, fasst den letzten ausstehenden Datensatz pro Sitzung zusammen und entleert die Warteschlange beim Verwerfen des Plugins. Lesbare Logs und Ledger-Historie werden beim Aktivieren des Plugins nachgefüllt, sodass erfolgreich persistierte Daten Neuladungen oder das Löschen von Sitzungen überstehen; das Löschen eines Workspace behält ebenso seine Historie, summiert in einer Zeile „Gelöscht“ zusammen mit Usage, die noch nicht das Ledger erreicht hatte
- Daten auf Tagesebene behalten jedes lesbare historische Sitzungsdatum mit erfasster Usage; die Heatmap ist eine Ansicht mit umschaltbarem Zeitraum (letzte 30 Tage / 90 Tage / 12 Monate, standardmäßig 12 Monate), keine feste Ansicht der letzten 53 Wochen
- Nach dem Löschen einer Sitzung wird erfolgreich geflushte Usage aus dem separaten Ledger wiederhergestellt; Disposal-Hinweise und periodische Abstimmung lösen Neuaufbauten aus, ohne Ledger-Zeilen zu löschen
- Pro Sitzung und logischem `turn / step` wird nur der finale Usage-Beitrag behalten; Wiederholungen oder ersetzte Nachrichten zählen nicht doppelt
- Input-Token sind frisch (ohne Cache-Treffer und Cache-Writes, die in eigenen Buckets liegen); All-zero-Usage-Replays überschreiben erfasste Usage nicht, und reine Cache-Read-Anfragen zählen weiterhin
- Die Versionsprüfung ist ein einzelnes schreibgeschütztes GET an `registry.npmjs.org` (nur die Versionsnummer von `dsh-all-usage`: kein Body, keine Cookies; vom Host ausgelöst und 6 Stunden lang gecacht, die Seite selbst erreicht nie das Netzwerk), und eine fehlgeschlagene Prüfung degradiert zu „unbekannt“, statt zu raten
- Der schlanke Status-Endpunkt liefert die Host-Instanz, die Statistik-Revision, den Scan-Fortschritt, Sync-Zähler, die `memory`-Residenzzähler, `counters` (diagnostische Operationszähler), `accounting` (Konsistenz der heutigen Aggregate) und `mismatch` (die erste Bucket-Delta-Inkonsistenzprobe oder null) sowie den letzten Client-Umgebungsbericht (User-Agent, Viewport, reservierter Streifen und seine Quelle, Panel-Rechtecke — von einem lokalen Client gemeldet und nur im Speicher gehalten). Die Mismatch-Probe trägt den internen Usage-Key und die Workspace-ID (ein Usage-Key wird aus der Sitzungs-ID abgeleitet und kann auf eine Sitzung zeigen); der Endpunkt enthält nie Prompts, Antworttexte, Workspace-Pfade oder Zugangsdaten; vollständige Snapshots werden erst nach Statusänderungen oder einem manuellen Refresh geholt
- Bereichsbezogene Ergebnisse behandeln Turns, Modellaufrufe und verschiedene Sitzungen als getrennte Metriken; fehlende Routenidentität ist explizit Unknown und wird nicht aus einem Anzeigelabel abgeleitet
- Der Datensatz-Endpunkt gibt nur einen kurzen Hash, Zeitpunkt, Workspace-ID, strukturierte Modellidentität, Turn/Step, Token-Buckets und die aktuelle Materialisierungsquelle zurück. Er lässt rohe Sitzungs-IDs, Pfade, Prompts, Antworten und Zugangsdaten weg
- Verarbeitete Token = Input + Output + Cache-Read/Write + Reasoning; ein Cache-Treffer bedeutet wiederverwendeter Kontext, nicht neu erzeugte Token oder tatsächliche Kosten
- Kosten folgen der Vier-Bucket-Formel von cc-switch: Input-, Output-, Cache-Read- und Cache-Write-Token werden einzeln bepreist, summiert und dann mit dem finalen Multiplikator multipliziert; wenn der Eingabekontext strikt größer als eine Kontext-Stufen-Schwelle ist, wechseln alle vier Tarife für die gesamte Anfrage, statt progressiv gestaffelt zu werden, und DSH-Reasoning wird nicht ein zweites Mal zum Output addiert
- Zeitabhängige Preisgestaltung gleicht UTC-Wochentage gegen halboffene Zeitfenster ab: Eine passende Anfrage nutzt die Peak-Tarife der Regel, alles andere die Basistarife der Zeile (Off-Peak = Basis); Usage vor dem Wirksamkeitszeitpunkt eines Plans hat kein verifizierbares Band und bleibt geschlossen ohne Preis, statt die heutigen Tarife zu erben, und ein Plan wird von jeder Zeile geteilt, die aus demselben Eintrag bepreist wird (für DeepSeek enthält der integrierte Plan die offizielle Feiertagsliste des Staatsrats, aktualisiert mit Plugin-Releases); bei aktiviertem Feiertagsschalter passt ein gesetzlicher Feiertag nie auf ein Peak-Fenster, und der Kosten-Snapshot speichert pricingHoliday, sodass Datensätze statt eines einfachen Off-Peak-Bands „Feiertag Off-Peak“ zeigen. Die integrierte DeepSeek-Tabelle liefert die Regelung für 2026 bereits mit (aktualisiert mit Plugin-Releases), sodass Erstanbieter- oder zugeordnete DeepSeek-Zeilen Feiertage ohne Konfiguration als Off-Peak bepreisen; Reseller-Routen bleiben statisch, bis sie dem offiziellen Eintrag zugeordnet werden
- Legacy-Ledger-Kosten, die `tiered` tragen, werden beim Laden zu `unsupported` (`tiered-pricing-not-modeled`) migriert, statt fälschlich als aktuelle Pauschalschätzungen markiert zu bleiben; die Token-Statistiken sind unverändert.
- Der Preis-Sync ist standardmäßig aus; wenn models.dev nicht verfügbar ist, bleibt der letzte gute Katalog in Verwendung, und nicht zugeordnete Modelle erhalten nie einen geratenen Standardpreis; die Preisfelder der Kosteneinstellungen sind der Einstiegspunkt für manuelle Preise (geteilt von jeder Zeile, die aus demselben offiziellen Modell bepreist wird), jede Zeile klappt zu Kontext-Bändern und UTC-Peak-Regeln auf (einschließlich optionaler ganztägiger Off-Peak-Preise an chinesischen gesetzlichen Feiertagen), und die integrierte DeepSeek-Tabelle kann zum Anpassen kopiert oder wiederhergestellt werden; Dashboard-Zeitraum und Detailansicht-Präferenzen werden im Browser-Speicher abgelegt, während der 6-Stunden-Sync-Schalter sofort über die geschützte Pricing-API gespeichert wird
- Zuordnungssemantik: Eine Zuordnung mit `identityKey` gilt nur für genau diese Routenidentität; eine Zuordnung ohne Identitätsschlüssel ist der modellweite Fallback. Legacy-Werte von `usageIdentityKey` werden beim Laden normalisiert.
- Der Feiertagskalender wird nur geladen, wenn der Benutzer auf „Aus öffentlichem Kalender laden“ klickt: Die Anfrage geht an `cdn.jsdelivr.net` (mit Rückfall auf `raw.githubusercontent.com`), trägt nichts außer dem Jahr und enthält **niemals Usage-, Sitzungs- oder Zugangsdaten**; die zurückgegebenen Tage bleiben wirkungslos, bis sie gespeichert werden, und beim Speichern werden sie zusammen mit ihrer Quellenangabe in den Peak-Plan dieses Modells eingefroren (die Quelle ist vom Policy-Hash ausgeschlossen)
- Guthabendaten stammen vom offiziellen `/user/balance`-Endpunkt von DeepSeek; die Karte zeigt einen Hinweis, wenn kein API-Schlüssel konfiguriert ist
- Der englische Modus nutzt UTC für Datums-Buckets, Zeitraumfilter, Streaks, Heatmap-Daten und Export-Zeitstempel; der chinesische Modus nutzt die lokale Zeit
- Das Ledger ordnet jede Sitzungs-ID einem von 32 stabil gehashten Verzeichnissen zu und hält **ein Datensatzdokument pro Sitzung**, sodass ein Flush genau diese eine Datei veröffentlicht, statt einen Shard neu zu schreiben; die alten Gesamtdateien (einschließlich der ursprünglichen `all_usage_ledger.json`) werden entfernt, sobald der Datensatzbaum die Daten nachweislich enthält, und `DSH_ALL_USAGE_KEEP_LEGACY=1` behält sie. Ein asynchroner Schreibfehler oder ein nicht geflushtes Herunterfahren verliert keine Statistiken im Speicher; der nächste Start scannt diese Sitzung einfach erneut
- Nur Sitzungen, die sich über ihr Arbeitsverzeichnis einem registrierten Workspace zuordnen lassen, werden einbezogen

## Konfiguration

| Einstellung | Ort | Beschreibung |
| --- | --- | --- |
| Modellpreise und Regeln | Dashboard „Kosteneinstellungen“ | Der models.dev-Sync ist standardmäßig aus; ordnen Sie offizielle Modelle zu, setzen Sie manuelle Preise, konfigurieren Sie Kontext-Stufen, UTC-Peak-Fenster und Off-Peak-Regeln für chinesische gesetzliche Feiertage. Formeln und Grenzen siehe Datensemantik. |
| Workspace-Aliase | DSH-Seitenleiste; KV-Einheit `all_usage_aliases` unter `$DSH_HOME/storages` | Ersetzt Workspace-Namen in der Anzeige. |
| Zeitraum- und Detailpräferenzen | Browser-lokaler Speicher | Der ausgewählte Dashboard-Zeitraum und die Detailansicht werden lokal gespeichert. |
| Oberer Innenabstand im Electron-Client | Browser-`localStorage`-Schlüssel `dsh-all-usage:topInset` | Setzen Sie einen Pixelwert, um den reservierten Streifen anzupassen; `0` deaktiviert ihn. Zum Anwenden neu laden. |
| Legacy-Ledger-Shards behalten | Host-Umgebungsvariable `DSH_ALL_USAGE_KEEP_LEGACY=1` | Alte Gesamt-Shard-Dateien werden entfernt, nachdem der Datensatzbaum pro Sitzung bestätigt ist; auf `1` setzen, um sie zu behalten. |
| Budget für residente Usage-Zeilen | Host-Umgebungsvariable `DSH_ALL_USAGE_RESIDENT_ROWS` | Zeilen, Standard 12000; ein endlicher Wert wird abgerundet (Math.floor). Ein negativer Wert hält jede Detailzeile resident; `0` gibt jede verdrängbare Zeile zurück, sobald ein Scan endet; ein nicht numerischer Wert fällt auf den Standard zurück. Das ist ein weiches Budget: Zeilen mit ungeklärtem Preis und Zeilen einer Sitzung, die gerade geschrieben, gelesen, neu synchronisiert oder vorab geladen wird, werden nie zurückgegeben. |
| Limit für den Sitzungsdatensatz-Cache | Host-Umgebungsvariable `DSH_ALL_USAGE_RECORD_CACHE_MB` | MiB, Standard 16. Nur ein endlicher Wert ≥ 0 wird akzeptiert; ein negativer oder nicht numerischer Wert fällt auf 16 zurück. `0` verdrängt nur verdrängbare saubere Datensätze bis auf den neuesten, sodass geschützte Datensätze die tatsächliche Residenz über das Budget heben können. Das ist ein weiches Budget: ein geänderter, ausstehender, schreibender, neu synchronisierender, vorab ladender oder lesender Datensatz wird nie verdrängt, und ein Ledger-Store, der einen Datensatz nicht zurücklesen kann, hält jeden Datensatz resident. Die Residenz wird aus der Anzahl der Usage-Zeilen geschätzt (keine gemessene Zuweisung); siehe `recordCacheMB` im Status. |

## API und CLI

### CLI

Das Plugin hat keine eigene Laufzeit-CLI. Der offizielle Installationsbefehl steht im Schnellstart; Entwicklungs- und Testbefehle sind unten aufgeführt.

### HTTP-API

- `GET /api/all-usage` — kompatibler Usage-Snapshot
- `GET /api/all-usage/status` — leichte Revision und Sync-Zustand, dazu der letzte Client-Umgebungsbericht (`clientEnv`), die laufende Plugin-Version (`pluginVersion`) und eine abgeleitete ID der Schreibfähigkeit (`capabilityId`, ändert sich beim Rotieren der Fähigkeit, damit die Seite ein Plugin-Neuladen bemerken kann; die Fähigkeit selbst wird nur im vollen Snapshot gesendet), plus die `memory`-Residenzzähler: `residentRows` (residente Usage-Detailzeilen), `residentRecords` (residente Sitzungsdatensätze), `recordCacheMB` (Größe des Sitzungsdatensatz-Caches in MiB mit einer Nachkommastelle; eine aus Usage-Zeilenzahlen abgeleitete Schätzung, keine gemessene Zuweisung), `sessions` (Sitzungsaggregate), `recordsCache` (Statistik des Datensatz-Query-Caches) und `heapUsedMB` / `rssMB` (beide gehören zum gesamten Host-Prozess, nicht allein zum Plugin). Dieselbe Antwort trägt `counters` (diagnostische Operationszähler), `accounting` (Konsistenz der heutigen Aggregate) und `mismatch` (die erste Bucket-Delta-Inkonsistenzprobe oder null)
- `GET /api/all-usage/query` — bereichsbezogenes Aggregat, Tages-/Stunden-Trend und Heatmap-Daten; Ein-Tages-Bereiche füllen `hourly`, während bereichsübergreifende Bereiche ein leeres `hourly`-Array zurückgeben
- `GET /api/all-usage/records` — paginierte, datenschutzsichere kanonische Usage-Zeilen
- `POST /api/all-usage/archive` — überführt Sitzungsdatensätze, die älter als `days` Tage sind (Standard 90, eine ganze Zahl in 1–3650), in `<root>/archive/<YYYY-MM>.jsonl.gz` und entfernt danach ihre Baumdokumente, sobald die Monatsdateien dauerhaft gespeichert sind; der Standard ist nur ein Plan (`dryRun: true`), und nur ein explizites `dryRun: false` schreibt; es nimmt dieselbe Wartungssperre wie die Migration und die CLI, antwortet `{ ok, months, archived, bytes, compressed, dryRun, errors }` und mit 409, wenn die Sperre gehalten wird. Benötigt dieselbe lokale Schreibfähigkeit wie das Speichern von Preisen
- `GET /api/all-usage/icon?key=<brand key>` — liefert ein Markenlogo auf Abruf (SVG mit langem Cache und einem ETag); das Client-Bundle trägt nur die Auflösungsmetadaten, sodass das Hinzufügen einer Marke es nicht mehr wachsen lässt
- `GET /api/all-usage/version?force=1` — Versionsprüfung: die laufende Version, die neueste veröffentlichte Version, das Urteil (`latest` / `outdated` / `unknown`), wann geprüft wurde und woher das Ergebnis kam; im Host 6 Stunden gecacht mit höchstens einer Upstream-Anfrage alle 30 Sekunden pro Prozess (die Untergrenze gilt auch für `force=1`), `force=1` kommt vom Refresh-Button
- `GET /api/all-usage/balance?force=1` — Kontostand mit dem konfigurierten `llm-deepseek`-API-Schlüssel
- `POST /api/all-usage/alias` — Workspace-Aliase aktualisieren
- `GET /api/all-usage/pricing` — die vollständige editierbare Preistabelle lesen: effektive Tarife und Status pro Zeile, Zuordnungen, manuelle Preise, Peak-Pläne (mit ihrem integrierten oder expliziten Ursprung und den vollständigen Regeln) und Zeilen, die nur in der Konfiguration existieren
- `GET /api/all-usage/pricing/models?q=...` — offizielle Modell-IDs und Anzeigenamen suchen, einschließlich Vorschautarifen, Kennzeichen für gestufte Preise und ob eine integrierte Peak-Tabelle existiert
- `POST /api/all-usage/pricing` — Sync, Zuordnungen, manuelle Preise, Kontext-Tarifbänder und Peak-Fenster-Regeln speichern (Anfrageform unverändert)
- `POST /api/all-usage/pricing/sync` — models.dev synchronisieren und unbepreiste Aufrufe nachfüllen
- `POST /api/all-usage/pricing/holidays` — ein Jahr der chinesischen Feiertagsregelung abrufen (das holiday-cn-Dataset, zuerst jsDelivr mit GitHub-raw-Rückfall, hostseitig 24 Stunden gecacht) und nur die Liste der freien Tage plus ihre Quelle zurückgeben; **nichts wird in die Konfiguration geschrieben** — der Client friert die Datumsangaben in einen Peak-Plan ein
- `GET /api/all-usage/client-env` — Client-Umgebungsbericht (User-Agent, Höhe des Window-Controls-Overlay, der reservierte Streifen **und seine Quelle**, Viewport, Panel-Rechtecke); der Client meldet ihn beim Laden und bei jedem Öffnen des Sheets, nur im Speicher gehalten

## Entwicklung und Tests

- Nach dem Bearbeiten von `src/client.js` führen Sie `npm run build:client` aus, laden das DSH-Client-Modul neu und aktualisieren die Seite; `lib/client.js` ist generiert und sollte nicht direkt bearbeitet werden. Nach dem Bearbeiten von `lib/plugin.js` oder eines anderen Host-Moduls laden Sie das Paket über DSH neu oder starten den Prozess neu
- Das Plugin hat keine Laufzeit-Abhängigkeiten von Drittanbietern: Der Host nutzt Cordis-Services, und der Client nutzt das von der Runtime bereitgestellte React-Modul; festgepinntes Terser ist nur eine Entwicklungsabhängigkeit zum Erzeugen des Browser-Artefakts
- Manuelle npm-Recovery-Publikationen erfordern ein Ziel-Tag `v<package.version>` und den vollständigen Commit-SHA; GitHub Actions prüft beides gegen das ausgecheckte Tag und die Paketversion. Release-Events führen dieselbe Commit-Prüfung durch.

### Lokale Prüfungen

~~~bash
npm test
npm run fixture:check
npm run build:client
npm run check:pack
~~~

## Status und Updates

Das neueste veröffentlichte Release ist `v1.2.2` ([GitHub Release](https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.2.2) | npm: `npm i dsh-all-usage@1.2.2`). Die vollständige Entwicklungs- und Release-Historie steht in [CHANGELOG.md](CHANGELOG.md).

### Zuletzt veröffentlicht: v1.2.2

- **Das Trenddiagramm lässt sich auf Balken umschalten**: Oben rechts befindet sich ein Umschalter Linie / Balken; Balken stapeln je Zeile eine Säule nach Token-Typ, mit der Summe oben, wachsen von der Grundlinie (kein Wachstum bei reduzierter Bewegung), und die Wahl wird gemerkt.
- **Unterstützung für DSH `0.2.2-alpha.3` und `0.2.2-rc.1`**: Beide exakten Versionen sind auf der echten Runtime verifiziert.
- **„Heute“ behält seine Stundenkurve**: Der Wechsel auf Heute zeigt den Stundenverlauf des Tages ohne manuellen Refresh.
- **Ein günstigeres Panel und Idle-Polling**: Der dauerhafte Glow und drei Backdrop-Blur-Effekte sind entfallen, und das Idle-Polling rendert das Dashboard nicht mehr neu, wenn sich die Payload nicht geändert hat.

Die vollständige Versionshistorie steht in [CHANGELOG.md](CHANGELOG.md).

## Mitwirken und Kontakt

Verwenden Sie für Fehlerberichte die Vorlagen unten. Für allgemeine Fragen oder Feature-Diskussionen besuchen Sie das [Projekt-Repository](https://github.com/ParticleLight/dsh-all-usage). Pull Requests sind willkommen; Fehlerberichte sollten die Versionen von DSH, Node.js und Plugin enthalten.

- [Dateninkonsistenz](.github/ISSUE_TEMPLATE/data-inconsistency.md)
- [Plugin-Startfehler](.github/ISSUE_TEMPLATE/startup-failure.md)
- [Kostenberechnungsproblem](.github/ISSUE_TEMPLATE/cost-calculation.md)

## Lizenz

MIT

# dsh-all-usage

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-all-usage?label=npm&color=4D6BFE)](https://www.npmjs.com/package/dsh-all-usage)
[![downloads](https://img.shields.io/npm/dt/dsh-all-usage?label=downloads&color=4D6BFE)](https://www.npmjs.com/package/dsh-all-usage)
[![stars](https://img.shields.io/github/stars/ParticleLight/dsh-all-usage?label=stars&logo=github)](https://github.com/ParticleLight/dsh-all-usage/stargazers)
[![license](https://img.shields.io/github/license/ParticleLight/dsh-all-usage?label=license&color=green)](LICENSE)
[![CI](https://github.com/ParticleLight/dsh-all-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/ParticleLight/dsh-all-usage/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/badge/DSH-0.1.1--0.2.0-4D6BFE)](#compatibility-and-known-limitations)
[![status](https://img.shields.io/badge/status-stable-brightgreen)](https://github.com/ParticleLight/dsh-all-usage/releases)

[中文](README.md) · [English](README.en.md)

## Overview

A full usage dashboard for DeepSeek Harness. Analyze tokens, cache behavior, estimated cost, account balance, and activity by model, provider, workspace, and time range.

### Features

- **Heatmap**: an activity heatmap with a switchable span (**last 30 days / 90 days / 12 months**; shorter spans get larger cells), workspace filters and daily turn/token details
- **Model analytics**: mixed view, model-merged view, and provider summary with calls, token categories, and cache hit rate; model rows and the model filter dropdown render vendor brand SVG icons (**43 brands**, including Mistral, Cohere, NVIDIA, Amazon Nova, Phi, Perplexity, ERNIE, Hunyuan, StepFun, SenseNova, InternLM, LongCat, **Xiaomi MiMo**, AI21, Granite, Solar, LFM, OLMo, BGE, Voyage, ByteDance Seed, Kling, Skywork, **Aion, Nous Research, TII Falcon, Aleph Alpha, Yandex, Snowflake and iFlytek Spark**); gateway and cloud envelopes (`openai-gpt-5.5`, `databricks-claude-*`, `google.gemma-3-12b-it`, `eu.anthropic.claude-*`) resolve back to the real brand, while unknown or gateway-private ids stay neutral
- **Summary and workspaces**: processed tokens, cache hits, estimated cost, account balance, usage streaks, workspace distribution, and details
- **Cost statistics / price table**: sync model prices from models.dev, calculate four cost buckets, persist price snapshots, and distinguish priced, free, ambiguous, and unpriced calls. Cost Settings is one editable price table: each row is a ledger model, its price boxes write that model's manual price, the official-model column switches the row to the catalog price, and every row can carry context rate bands and time-of-day (UTC peak/off-peak) rules, including an optional "Chinese statutory holidays price as off-peak all day" switch whose explicit date list lives in that model's peak plan (China Standard Time calendar days, 2026-10-01..2026-10-07 ranges supported, and one click loads the year's arrangement from a public calendar before it is frozen into the policy); rows that exist only in the saved configuration stay visible, editable, and removable
- **CSV export**: export data using the selected time range and aggregation mode
- **Time ranges**: today, **last 7 days**, last 30 days, last 90 days, all time, or a custom start/end date across all available historical daily data; the heatmap span switches independently (30 days / 90 days / 12 months)
- **Workspace aliases**: manage aliases from the sidebar dashboard; values persist in the $DSH_HOME/storages KV cell `all_usage_aliases`
- **Interface language**: switch between Chinese and English from the dashboard header; your choice persists locally in the browser
- **Full history & incremental rebuild**: the baseline scans every readable historical session; the durable usage ledger doubles as a per-session cursor, so unchanged sessions are reused straight from the ledger and only newly appended events are folded — long histories restart without a full rebuild
- **Restart with no re-read**: the persisted log revision (a header-line + stat via `sessionPersistence.listSnapshots()`) acts as a per-session change signal — sessions whose log is unchanged are applied from the ledger on restart without reading their events at all; only changed/new sessions are read incrementally
- **Workspace registry sync**: follows DSH's `domain/changed` event so the workspace registry stays fresh automatically — any durable registry write (create/delete/rename/reorder/archive/membership) triggers a reread of `workspaceRegistry.list()`, with only added/removed workspaces reprocessed incrementally while unchanged workspaces reuse their computed aggregates and ledger (zero rescan). Usage is strictly limited to registered workspaces: unregistered cwds, including existing directories absent from the registry, are ignored.
- **Data health and on-demand refresh**: after a scan completes, the browser polls only a lightweight status revision and fetches full history only after usage, alias, or sync state changes; it shows the latest full-data update, historical scan health, revision skips, rereads, ledger recovery, and failures while preserving last-good data on network errors
- **Performance**: Host maintains ingest-time local/UTC day, workspace, model-identity cubes and single-day hour buckets; scope queries merge buckets, exact costs use BigInt decimal accumulators, and the 53-week heatmap emits only the fields it consumes, while revision-scoped snapshot/records caches and recyclable live-event queues remain in place. Client isolates the heatmap, tooltip, trend, donuts, request records, and pricing dialog behind memoized boundaries; pointer coordinates update through refs plus requestAnimationFrame instead of rerendering the page, and the browser entry is deterministically minified before packing
- **Trend line chart**: show input, cache read/write, output, reasoning, and total processed tokens for the active range, timezone, workspace, provider, and model scope; use hourly buckets for a single-day scope, daily buckets for cross-day scopes, and **an automatically coarser stride above 180 days** (three days first, then a week / 10 days / 2-3 weeks / month / quarter / year as needed, capped at 180 points; the panel names the stride and a multi-day point skips the single-day drilldown); smooth monotone curves, staged entrance animation, hover for exact values, and click a point to inspect that day
- **Version indicator**: the header shows the running version next to the title — “Up to date” in small text when it matches the newest release on npm, “Latest vX.Y.Z” highlighted when it is behind, and a click opens the GitHub repository; the host caches the check (6 hours by default) and only the refresh button forces a new one
- **Unified filters and audit**: workspace, provider, model, and date filters apply to the summary, heatmap, trend, tables, and CSV; workspace, provider, and model filters remain independent and can be combined freely, while workspace, provider, and model options are limited to values used in the selected date range and stale selections clear automatically; request logs stay visible as a compact paginated table with grouped Token details for the selected row
- **Token accounting semantics**: input tokens are fresh (exclude cache hits/writes, which sit in separate buckets along with reasoning); all-zero usage replays never overwrite recorded usage, while cache-only requests still count
- **Cost semantics**: prices come from the models.dev USD per 1M token catalog; DSH-normalized fresh input and the four cost buckets are snapshotted at calculation time, the multiplier applies only to final total, and existing positive historical costs are not recalculated; matching uses the model's official vendor entry and ignores the DSH provider, while missing official prices stay unpriced

### Compatibility and Known Limitations

- **Runtime**: Node.js `>=22 <25` is required. CI runs the test suite, syntax checks, and package-content checks on Node 22 and Node 24.
- **DSH compatibility**: `package.json` declares DSH runtime `>=0.1.1-rc.1 <0.1.5-0 || >=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.2 <0.1.8-0 || >=0.2.0-rc.2 <0.2.1-0`; the real Cordis service chain is verified on `0.2.0-rc.2`, `0.1.7-rc.2`, `0.1.5-rc.2`, `0.1.5-rc.1`, `0.1.1-rc.2` and `0.1.1-rc.1`, all of them covered by the CI smoke matrix on Node 22 and 24. `0.1.2-rc.1` has also been verified compatible through real-world use, but is not covered by the CI smoke matrix. The declaration is split per tuple rather than written as one interval because node-semver only admits a prerelease version when some comparator shares its exact `major.minor.patch` tuple and itself carries a prerelease tag — `0.2.0-rc.2` is admitted only because the range says `>=0.2.0-rc.2`.
- **Desktop client (Electron, Windows)**: the plugin is verified running in the DSH desktop client (`@deepseek-ai/dsh-desktop` `0.1.7-rc.2` as measured). The desktop client keeps a 40px caption strip across the top of its window for its own minimise / maximise / close buttons and marks the document with `data-windows-titlebar` and `--dsh-windows-titlebar-height`; the panel draws from **below** that strip, so the client's own close button is never covered. Browsers carry no such marker and reserve nothing. The strip height comes from the host's declaration first, then the Window Controls Overlay rectangle, then the user agent; to tune it, run `localStorage.setItem('dsh-all-usage:topInset', '48')` in DevTools and reload (`0` reserves nothing) — no rebuild required. The desktop client ships its own runtime, and that runtime — `0.1.7-rc.2` — is now part of the declared range and of the CI smoke matrix below.
- **Web service dependency**: the Host declares `webServer` as a required dependency, so DSH waits for a late-mounted service before applying the plugin; this package targets the DSH Web profile and does not expose routes without WebServer. The HTTP guard also checks the actual socket peer, so a reverse proxy is accepted only when the connection itself is loopback.

| DSH runtime | Node.js support | Real Cordis smoke | Conclusion |
| --- | --- | --- | --- |
| `0.2.0-rc.2` | `>=22 <25`, CI covers 22/24 | Passed (real Cordis service chain, CI covers Node 22/24) | Declared and verified (the current DSH `next` line; this machine's web profile runs it) |
| `0.1.7-rc.2` | `>=22 <25`, CI covers 22/24 | Passed (real Cordis service chain, CI covers Node 22/24) | Declared and verified (the DSH desktop client runs this version) |
| `0.1.5-rc.2` | `>=22 <25`, CI covers 22/24 | Passed (real Cordis service chain, CI covers Node 22/24) | Declared and verified |
| `0.1.5-rc.1` | `>=22 <25`, CI covers 22/24 | Passed (real Cordis service chain, CI covers Node 22/24) | Declared and verified |
| `0.1.2-rc.1` | `>=22 <25` | Passed through real-world use (not in CI) | Verified compatible in real-world use |
| `0.1.1-rc.2` | `>=22 <25`, CI covers 22/24 | Passed (real Cordis service chain, CI covers Node 22/24) | Declared and verified |
| `0.1.1-rc.1` | `>=22 <25`, CI covers 22/24 | Passed (real Cordis service chain, CI covers Node 22/24) | Declared and verified |
| Other versions | `>=22 <25` | Not tested | Outside the verified matrix |

An unlisted DSH version is not necessarily incompatible. Include the DSH, Node.js, and plugin versions when reporting an issue.

- **Interrupted requests**: an interrupted upstream request may emit only `assistant/chunk` usage and never produce a final `assistant/message`; that chunk is retained. A later final message for the same turn/step replaces it. If the upstream emits no usage event at all, exact token usage cannot be reconstructed from response text.
- **Estimated cost**: cost is an estimate based on models.dev rates and DSH usage buckets, not a provider invoice. Unavailable catalogs and unmatched models remain unpriced instead of receiving guessed rates. Cache reads, cache writes, and reasoning follow the buckets reported by the upstream DSH event.
- **Tiered prices**: models.dev context-tiered entries select the applicable rate from the request input context (fresh input plus cache read/write tokens); malformed schedules remain unsupported.
- **Workspace boundary**: only sessions whose cwd maps to a DSH-registered workspace are included. Unregistered cwds, including existing directories absent from the registry, are ignored. The registry is kept fresh by a `domain/changed` probe: any durable workspace-domain write triggers a reread, and only added/removed workspaces are reprocessed incrementally — unchanged workspaces reuse their computed aggregates and ledger. Data deleted or corrupted before a successful session flush cannot be recovered from the separate ledger.

### Local Statistics vs Official Billing

This plugin reports replayable statistics from local DSH event logs; it is not a mirror of a provider invoice:

- Local statistics read DSH `assistant/chunk`, final `assistant/message`, and related session events, then deduplicate and replace samples by logical `turn / step`. Official billing may use a provider tokenizer, rounding rules, discounts, free quotas, and billing periods.
- A failed request is included locally whenever it leaves a usage chunk; whether the provider charged for that failed request must be checked against the official bill.
- Prices come from the public models.dev catalog and local explicit overrides. Catalog prices can differ from provider prices, regional rates, and invoice discounts, so the cost field is an estimate. A price belongs to the model, so every row priced from the same official model shares one manual entry; price edits never rewrite existing positive costs, while a peak-plan change reconciles that model's history against the new policy.
- Local statistics include registered workspaces only; old ledger rows for unregistered cwds are excluded. Usage recorded for a **deleted workspace** is kept and summed into one "Deleted" row, so removing a workspace never shrinks historical totals. Totals can still be lower than the official bill when logs are damaged, cleaned up, or the upstream emits no usage event.

### Reproducible Event Examples

The following are redacted minimal examples; the complete runnable data is in [`fixtures/usage-events.json`](fixtures/usage-events.json).

#### Retaining a failed request chunk

~~~json
[
  {"type": "assistant/chunk", "data": {"turn": 1, "step": 1, "chunk": {"type": "usage", "usage": {"inputTokens": 100, "outputTokens": 20}}}},
  {"type": "request/error", "data": {"code": "upstream-failed"}}
]
~~~

Without a final `assistant/message`, the chunk remains one local call; this does not mean the provider necessarily charged for it.

#### Orphan usage chunk

~~~json
{"type": "assistant/chunk", "data": {"turn": 1, "step": 1, "chunk": {"type": "usage", "usage": {"inputTokens": 7, "cacheReadTokens": 8}}}}
~~~

Without request/context or request/header, tokens are still counted, but the model identity is shown as Unknown; the plugin does not guess a model from a provider name or display string.

#### Cache token buckets

~~~json
{"inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 40, "cacheWriteTokens": 5, "reasoningTokens": 3}
~~~

The local processed total is `100 + 20 + 40 + 5 + 3 = 168`; cost uses the input, output, cacheRead, and cacheWrite buckets, and reasoning is not added to output again.

Replay the repository fixture:

~~~bash
node scripts/replay-fixture.mjs fixtures/usage-events.json
~~~

The command loads the real plugin Host, calls its compatible APIs, checks the documented token/record totals, and prints a non-sensitive summary.

### Report An Issue

- [Data inconsistency](.github/ISSUE_TEMPLATE/data-inconsistency.md)
- [Plugin startup failure](.github/ISSUE_TEMPLATE/startup-failure.md)
- [Cost calculation issue](.github/ISSUE_TEMPLATE/cost-calculation.md)

### Latest Update

**v1.1.18**

- **A new “Last 7 Days” range**: the presets are now Today / **Last 7 Days** / Last 30 Days / Last 90 Days / All Time / Custom; it covers seven calendar days including today and applies to the summary, trend, model tables, request log, filters and CSV export, with the choice remembered in the browser.
- **A switchable heatmap span (30 days / 90 days / 12 months)**: the column count follows the span (5 / 13 / 53 columns); each column is a week and the cells keep a 1:1 aspect ratio, so a shorter span also gets larger cells (18×18px at twelve months, 34×34px at 30/90 days, capped so a few columns cannot stretch into huge tiles). Twelve months stays the default and the span is independent of the time range above.
- **A version indicator next to the title**: it shows the running version, “Up to date” in small text when it matches the newest release on npm, a highlighted “Latest vX.Y.Z” when it is behind, and a click opens the GitHub repository. The host performs the check (one read-only request to the npm registry, cached for six hours, at most one every 30 seconds per process) and degrades to “unknown” rather than guessing.

See [CHANGELOG.md](CHANGELOG.md) for the complete version history.

### Installation

This is a standard DSH community bundle. It declares a `dsh.bundle` manifest and a web client, and backfills its data from persisted session logs and the durable usage ledger after installation.

#### Official plugin command (recommended)

~~~bash
dsh plugin --profile web add github:ParticleLight/dsh-all-usage
~~~

The installation command assembles the bundle. Refresh the browser page to load the client; no manual profile edits are required. If your DSH version does not dynamically assemble newly installed packages, use its supported package reload or restart the process.

#### Manual local registration

1. Place this directory anywhere and create a symlink to it under $DSH_HOME/profiles/node_modules/ (use a junction on Windows):

   ~~~powershell
   New-Item -ItemType Junction -Path (Join-Path $env:DSH_HOME 'profiles/node_modules/dsh-all-usage') -Target '<absolute plugin path>'
   ~~~

2. Add this entry to $DSH_HOME/profiles/web/cordis.patch.yml:

   ~~~yaml
   - insert:
       - id: all-usage
         name: dsh-all-usage
   ~~~

The profile patch layer hot-reloads; save the file and refresh the page.

### Architecture

- **Host** (entry `lib/index.js`, assembled by `lib/plugin.js`): split by responsibility across `aggregation.js` (aggregation/query), `ledger.js` (durable ledger), `session-sync.js` (history/live sync), `pricing-runtime.js` (runtime pricing), `balance.js` (balance), and `http.js` (protected routes); aggregates `turn/end`, `assistant/chunk` usage, and final `assistant/message.usage`, folds live `session/event` updates, and exposes data routes through `webServer`:
  - `GET /api/all-usage` — compatible usage snapshot
  - `GET /api/all-usage/status` — lightweight revision and sync health, plus the last client environment report (`clientEnv`), the running plugin version (`pluginVersion`) and a derived id of the write capability (`capabilityId`, changes when the capability rotates so the page can notice a plugin reload; the capability itself is only ever sent in the full snapshot)
  - `GET /api/all-usage/query` — scoped aggregate, daily/hourly trend, and heatmap data; single-day scopes populate `hourly`, while cross-day scopes return an empty `hourly` array
  - `GET /api/all-usage/records` — paginated privacy-safe canonical usage rows
  - `GET /api/all-usage/icon?key=<brand key>` — serves one brand mark on demand (SVG with a long cache and an ETag); the client bundle carries only the resolution metadata, so adding a brand no longer grows it
  - `GET /api/all-usage/version?force=1` — version check: the running version, the newest published version, the verdict (`latest` / `outdated` / `unknown`), when it was checked and where it came from; cached on the host for 6 hours with at most one upstream request every 30 seconds per process (the floor applies to `force=1` too), `force=1` comes from the refresh button
  - `GET /api/all-usage/balance?force=1` — account balance using the configured `llm-deepseek` API key
  - `POST /api/all-usage/alias` — update workspace aliases
  - `GET /api/all-usage/pricing` — read the full editable price table: per-row effective rates and status, mappings, manual prices, peak plans (with their built-in/explicit origin and full rules), and rows that exist only in the configuration
  - `GET /api/all-usage/pricing/models?q=...` — search official model IDs and display names, including preview rates, tiered-pricing flags, and whether a built-in peak table exists
  - `POST /api/all-usage/pricing` — save sync, mappings, manual prices, context rate bands, and peak-window rules (request shape unchanged)
  - `POST /api/all-usage/pricing/sync` — sync models.dev and backfill unpriced calls
  - `POST /api/all-usage/pricing/holidays` — fetch one year of the Chinese holiday arrangement (the holiday-cn dataset, jsDelivr first with a GitHub raw fallback, cached host-side for 24 hours) and return only the off-day list plus its source; **nothing is written to the configuration** — the client freezes the dates into a peak plan
  - `GET /api/all-usage/client-env` — client environment report (user agent, window-controls overlay height, the reserved strip **and its source**, viewport, panel rectangles); the client reports it at load and whenever the sheet opens, kept in memory only
- **Client**: readable source lives in `src/client.js`; `npm run build:client` uses the pinned Terser version to generate the `window.__ModuleLoader__` bundle at `lib/client.js`, which registers the “Usage statistics” sidebar entry through the `sidebar.footer.action` slot. All API routes accept loopback requests and reject an explicit cross-origin Origin; balance reads and alias writes also require a process-scoped token generated when the plugin starts (the balance GET tolerates browsers omitting Origin). **Writes are authorized by that token, not by an Origin**: the DSH desktop shell runs the UI on its own scheme and forwards requests through Electron, which strips `Origin` (with `Host`/`Cookie`/`Sec-Fetch-*`), so requiring one made every desktop save fail with 403. A present `Origin` must still be loopback or the shell's own scheme, and `Host` must still be loopback (DNS-rebinding guard).

### Data semantics

- Calls and tokens come from DSH session logs; `session/flush` rebuilds and queues the derived ledger only when related events are dirty, coalescing the latest pending record per session and draining on plugin disposal. Readable logs and ledger history are backfilled when the plugin activates, so successfully persisted data survives reloads or session deletion; deleting a workspace likewise keeps its history, summed into one "Deleted" row together with usage that had not reached the ledger yet
- Day-level range data retains every readable historical session date with tracked usage; the heatmap is a switchable-span view (last 30 days / 90 days / 12 months, 12 months by default), not a fixed latest-53-week view
- After a session is deleted, successfully flushed usage is restored from the separate ledger; disposal hints and periodic reconciliation trigger rebuilds without deleting ledger rows
- For each session and logical `turn / step`, only the final usage contribution is kept; retries or replaced messages do not double-count
- Input tokens are fresh (exclude cache hits/writes, which sit in their own buckets); all-zero usage replays do not overwrite recorded usage and pure cache-read requests still count
- The version check is a single read-only GET to `registry.npmjs.org` (the version number of `dsh-all-usage` only: no body, no cookies; issued by the host and cached for 6 hours, the page itself never reaches the network), and a failed check degrades to “unknown” instead of guessing
- The lightweight status endpoint exposes only the Host instance, stats revision, scan progress, sync counters, and the last client environment report (user agent, viewport, reserved strip and its source, panel rectangles — reported by a local client and kept in memory only). It does not expose session IDs, workspace paths, prompts, or reply bodies; full snapshots are fetched only after status changes or a manual refresh
- Scoped results keep turns, model calls, and distinct sessions as separate metrics; missing route identity is explicitly Unknown rather than inferred from a display label
- The records endpoint returns only a short hash, time, workspace ID, structured model identity, turn/step, token buckets, and current materialization source. It omits raw session IDs, paths, prompts, replies, and credentials
- Processed tokens = input + output + cache read/write + reasoning; a cache hit means reused context, not newly generated tokens or actual cost
- Cost follows the cc-switch four-bucket formula: input, output, cache-read, and cache-write tokens are priced independently, summed, then multiplied by the final multiplier; when input context is strictly greater than a context-tier threshold, all four rates switch for the whole request instead of progressive band splitting, and DSH reasoning is not added to output a second time
- Time-of-day pricing matches UTC weekdays against half-open windows: a matching request uses the rule's peak rates, anything else uses the row base rates (off-peak = base); usage before a plan's effective instant has no verifiable band and fails closed as unpriced instead of inheriting today's rates, and one plan is shared by every row priced from the same entry (for DeepSeek the built-in plan carries the official State Council holiday list, refreshed with plugin releases); with the holiday switch on, a statutory holiday never matches a peak window and the cost snapshot records pricingHoliday, so records show "Holiday off-peak" instead of a plain off-peak band. The built-in DeepSeek table already ships the 2026 arrangement (refreshed with plugin releases), so first-party or mapped DeepSeek rows price holidays as off-peak with no configuration; reseller routes stay static until they are mapped to the official entry
- Legacy ledger costs carrying `tiered` are migrated to `unsupported` (`tiered-pricing-not-modeled`) on load instead of remaining falsely marked as current flat priced estimates; token statistics are unchanged.
- Pricing sync is off by default; when models.dev is unavailable the last good catalog remains in use, and unmatched models never receive a guessed default price; the Cost Settings price boxes are the manual-price entry point (shared by every row priced from the same official model), each row expands into context bands and UTC peak rules (including optional all-day off-peak pricing on Chinese statutory holidays), and the built-in DeepSeek table can be copied for customisation or restored; dashboard range and detail-view preferences are stored in browser storage, while the 6-hour sync toggle is immediately saved through the protected pricing API
- Mapping semantics: a mapping with `identityKey` applies only to that exact route identity; a mapping without an identity key is the model-wide fallback. Legacy `usageIdentityKey` values are normalized when loaded.
- The holiday calendar is fetched only when the user clicks "Load from public calendar": the request goes to `cdn.jsdelivr.net` (falling back to `raw.githubusercontent.com`), carries nothing but the year, and **never includes usage, session, or credential data**; the returned dates stay inert until saved, and saving freezes them together with their source note into that model's peak plan (the source is excluded from the policy hash)
- Balance data comes from DeepSeek’s official `/user/balance` endpoint; the card shows guidance when no API key is configured
- English mode uses UTC for date buckets, range filters, streaks, heatmap dates, and export timestamps; Chinese mode uses local time
- The ledger assigns each session ID to one of 32 stable-hash directories and keeps **one record document per session**, so a flush publishes that one file instead of rewriting a shard; the old whole-unit files (including the original `all_usage_ledger.json`) are removed once the record tree provably holds the data, and `DSH_ALL_USAGE_KEEP_LEGACY=1` keeps them. An async write failure or an unflushed shutdown does not lose in-memory statistics; the next startup simply scans that session again
- Only sessions that can be mapped to a registered workspace by their working directory are included


### Storage and performance

- **One record per session**: the ledger writes each session as its own document (stable-hashed into 32 directories), so an update publishes one file. Measured on the same data: a single update went from rewriting a 13.27 MB shard (273 ms) to writing one record (a 4.6 ms median)
- **One identity per route**: usage items reference the route identity and its price definition instead of repeating them, so 1059 records shrank from **91.3 to 74.7 MB (-18%)**
- **The snapshot pays for one timezone only**: `GET /api/all-usage?utc=0|1` returns a single calendar (both copies used to split the payload in half), and a day keeps its session-id detail for the last **180 days** while older days keep counts and aggregates
- **The trend chart is capped at 180 points**: past half a year it drops to three days per point and widens to week / month / quarter / year, so the chart cannot grow with history
- **Budgets live in the code**: 20 query and 20 records cache entries, 5000 pricing resolutions, 512 context entries per session, 500 price rows, 32 shards, 180 trend points and a 180-day session-id window - guarded by `test/perf-budgets.test.js`, so relaxing one means editing that table
- **Reproducible benchmarks**: `node bench/ledger.mjs` (ledger size and per-update rewrite cost), `node bench/ledger-layout.mjs` (the two storage layouts, on copies of real shards) `node bench/endpoints.mjs` (median latency and payload of five read endpoints) and `node scripts/dead-code.mjs` (exports nothing references, client helpers nobody calls, stylesheet classes no markup can render)

### Development

- After editing `src/client.js`, run `npm run build:client`, reload the DSH client module, and refresh the page; `lib/client.js` is generated and should not be edited directly. After editing `lib/plugin.js` or another Host module, reload the package through DSH or restart the process
- The plugin has no third-party runtime dependencies: the Host uses Cordis services and the Client uses the runtime-provided React module; pinned Terser is only a development dependency for generating the browser artifact
- Manual npm recovery publishes require a target `v<package.version>` tag and full commit SHA; GitHub Actions checks both against the checked-out tag and package version. Release events perform the same commit check.

## License

MIT

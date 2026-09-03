# Changelog

All notable changes to `dsh-all-usage` are documented here.

## [Unreleased]

### Added

- DeepSeek peak/off-peak billing as a first-class, versioned **temporal pricing plan**: the cost schema is v2, and each cost snapshot records the billing instant, its time source (request-context / usage-event), the UTC band (peak / off-peak), the policy id, and a policy hash. Request logs show the band and UTC billing time, and the cost settings panel marks which usage models follow the DeepSeek band plan.
- Built-in first-party DeepSeek profiles (deepseek-v4-flash, deepseek-v4-flash-vision-exp, deepseek-v4-pro) with explicit per-band rates for the UTC windows 01:00-04:00 and 06:00-10:00 on weekdays; the peak rates are stored as data, never derived as an automatic discount rule.
- UTC band boundaries are half-open: 00:59:59 off-peak, 01:00:00 peak, 03:59:59 peak, 04:00:00 off-peak, 06:00:00 peak, 10:00:00 off-peak; weekends are off-peak. Band selection uses UTC fields only, so viewer timezones, DST, and fractional-hour zones cannot change a result.
- Deterministic reuse: a later usage sample for the same turn/step reuses the previous cost snapshot only when identity, token buckets, band, policy id/hash, and applicability all match, so a message crossing a peak boundary never inherits the chunk price.
- Requests preferred as the billing instant when the request/context time matches the usage turn/step; otherwise the usage event time is the auditable fallback. Both are persisted in the snapshot.
- Controlled DeepSeek temporal reconciliation: first-party DeepSeek snapshots are re-priced against the usage instant on baseline/backfill/sync, v1 snapshots are migrated to the v2 shape in memory and in the persisted ledger, and a plan whose effective window does not cover the instant fails closed as unsupported (temporal-price-history-unavailable) instead of guessing.
- Route safety boundary: the band plan applies only to first-party deepseek routes or routes explicitly mapped to the DeepSeek official entry; reseller routes (OpenRouter and other gateways) keep the static official price and are labelled route-not-official.

- Respect the official effective instant: the built-in DeepSeek band plan starts exactly at 2026-08-16T16:00:00Z (V4-Flash-Vision-Exp at 2026-08-21), and usage before it fails closed as unsupported instead of inheriting today's V4 rates.
- Persist the request-context archive inside ledger records and seed incremental folds from it after a restart, so an open request whose context arrived in a previous batch keeps its peak/off-peak billing instant.
- Clear stale request-context instants and route identity on full folds (baseline rebuilds and live resyncs), so a history rewrite that removes a request no longer leaves its band attached to later usage.
- Keep priced v2 snapshots auditable across catalog refreshes: the policy hash no longer includes live entry rates and reconciliation never rewrites priced history; an explicit repriceTemporal=true request re-estimates every snapshot.
- Support an ordered policy archive (policies: [...]) with non-overlapping effective windows, reject overlapping rules across rules (JSON array order can never decide a price), keep an invalid temporal config visible and fail closed instead of silently falling back to the built-in profile, and compare temporal plans in the duplicate-candidate check so conflicting band plans resolve ambiguous.
- Include pricingAt, pricingTimeSource, band, policy id and policy hash in the reconciliation equivalence check and in the CSV audit export.

- Persist the invalid temporal-config sentinel through the serialize/normalize cycle: a rejected temporalPricing edit stays fail-closed across restarts instead of re-enabling the built-in DeepSeek profile.
- Rebuild a session atomically on authoritative live resyncs: usage samples, turn records, date indexes and cost aggregates are removed before the snapshot is folded, so usage deleted by a rewritten history disappears from the aggregate (lagging snapshots keep upsert semantics until the follow-up resync aligns).
- Base the live resync cursor on the snapshot tail (merged with an absorbed fallback event) instead of the previous cursor, so truncated or rewritten history cannot skip over missing events that arrive later.
- Accept deepseek-official as a first-party catalog provider in the official provider rules, so its entries price and follow the band plan like deepseek.
- Validate that a priced snapshot's instant is still covered and band-consistent when deciding whether a policy still matches: snapshots that slipped into a gap (same id/hash, window moved) fail closed instead of staying priced.
- Include pricingAt and pricingTimeSource in the live/incremental reuse check, so audit metadata refreshes when the request instant or its source changes even within one band.
- Use real LRU eviction (delete + set) for the bounded request-context archive, applying the same 512-entry cap to the live fold, the persisted ledger, and deserialization.

- An authoritative live resync (full snapshot or a snapshot that provably contains the triggering event with a monotonic sequence) rebuilds the session's ledger record from the snapshot, replaces it in state and persists it, so a restart after a live history rewrite cannot resurrect deleted usage; persist failures keep explicit dirty/recovery state and surface as resync-ledger-persist-failed.
- Live resync authority is now proof-based: snapshots that only have a higher tail, or events without a usable sequence, are treated as lagging (upsert the event, stay pending, align on the follow-up resync) instead of being destructively replaced.

- Show real vendor brand icons instead of neutral dots for models in the request log, the selected-call details, the model summary table, and the cost-settings match table. The 11 brand SVGs live in assets/model-icons/ with a manifest (provider aliases, model prefixes, exact overrides, source and licence) and are validated and embedded as data: URIs by scripts/build-client.mjs, so the runtime never reads local paths or the network. Model namespaces win over the DSH provider name so reseller and gateway routes are attributed by the model they actually served; unknown or mixed-brand rows keep the neutral fallback, and workspace colour dots plus chart legend dots are unchanged.

- Harden the model brand icons: the load-failure flag is scoped to one icon identity (a shared component that later shows another brand retries instead of staying neutral), an unrecognised actualModel no longer inherits the requested model's brand, model prefixes match on token boundaries only (o10-preview and o3x stay neutral), the resolution cache is bounded, and labelled icons expose the brand through the image's accessible name instead of a title on an aria-hidden host.
- Build-time SVG validation now decodes XML entities before checking, rejects unquoted URI attributes, external CSS url()/image-set() and @import targets (including escaped/commented/CDO-CDC/namespaced <svg:style> forms), DOCTYPE/CDATA/processing instructions and every external-resource element; the CSS checks run only on style attributes and <style> bodies so icon text and comments stay inert. It lives in scripts/svg-guard.mjs so the tests exercise the exact same guard with adversarial fixtures.
- Bundle the icon provenance required for release: the manifest pins the upstream commit, records per-file upstream paths and modification flags, and assets/model-icons/LICENSE.upstream-lobe-icons.txt ships the MIT notice, copyright, trademark disclaimer and the local modifications. The build fails if the pinned revision, licence file or per-file attribution is missing.

## [1.1.3] - 2026-09-01

### Added

- Make Cost Statistics tier-aware: show expandable official rate schedules and support validated context bands in explicit price overrides.
- Added deterministic usage invariants and a redacted fixture replay command covering failed requests, orphan usage chunks, cache buckets, replacement semantics, and exact expected totals.
- Added a Node 22/24 CI matrix with package-content checks and required real DSH runtime smoke coverage for DSH 0.1.1-rc.1 and 0.1.1-rc.2.
- Added community issue templates for data inconsistencies, plugin startup failures, and cost calculation issues.

### Performance Optimizations

This release reduces historical scan work, storage write amplification, and Dashboard render churn while preserving durable-ledger recovery guarantees.

- Avoid rebuilding and writing a clean session's derived ledger at `session/flush`; queue and coalesce dirty records, then drain pending writes during disposal.
- Store derived ledger records in 32 stable-hash JSON units so a session update rewrites only its shard; retain the legacy single-unit migration path.
- Build scoped query and fixed 53-week heatmap results from ingest-time date/workspace/model cubes; use exact BigInt decimal accumulators and a minimal heatmap projection instead of rescanning usage rows or parsing cost strings on cold reads.
- Isolate heatmap pointer tracking from the dashboard render path: memoize the 53-week calendar, cells, lookup maps, charts, records, and pricing dialog, while tooltip coordinates are coalesced through refs and requestAnimationFrame, with a throttled fallback for background tabs.
- Generate the shipped browser entry from readable `src/client.js` with pinned Terser during prepack, reducing the current raw client artifact from about 276 KB to about 177 KB; transport gzip/Brotli remains a DSH host concern.

### Correctness

- Keep the usage ledger debounce timer referenced while write waiters are pending: an unreferenced timer let the event loop settle before `persistLedgerRecord` could run, cancelling Node 22 test runs and short-lived processes.
- Derive the latest session sequence from the tail event instead of scanning the full session log on live flush and again while building the ledger record.
- Use the previous ledger cursor for safe append-only tail folding and fall back to a full rebuild when sequence continuity or turn replacement is uncertain.
- Wait for the persisted pricing configuration (and the ledger it backfills) before serving pricing reads and writes, so an early API call can neither report an empty config nor be silently overwritten by the load.
- Force a full historical rebuild when the workspace behind a session path was recreated with a different id; the previous record can no longer be reused under the wrong workspace, and ledger rows whose top-level workspace differs from their historical items are marked unusable and rebuilt once.
- Keep the pricing refresh classification order intact: a pricing revision change always wins over a concurrent data change so summary costs and the open settings panel cannot consume a partially-consumed baseline.
- Refresh the open cost-settings panel when the pricing revision changes, merging fresh catalog data while preserving unsaved local mappings and overrides.
- Invalidate every in-flight official-model search when a mapping row is deleted (row generation bump), so a stale response can never populate a shifted row even when per-index sequence numbers collide.
- Skip the pricing revision bump when a catalog sync succeeds with an unchanged catalog hash and no newly priced usage.
- Round hourly bucket indices against the requested range so fractional-hour zone offsets (Lord Howe) never drop or merge events, and emit real bucket boundaries as trend labels so spring-forward hours carry the true 03:00 label instead of drifting 30 minutes off.
- Mark mixed-workspace ledger records as unfoldable so both the scan tail path and session flush rebuild them instead of persisting historical items under the wrong workspace.
- Exclude the per-fetch fetchedAt stamp from the catalog content hash, so syncing identical models.dev contents keeps pricingRevision (and query caches) stable.
- Wait for the persisted pricing and ledger state before serving the full snapshot, so the first payload cannot embed a default empty pricing summary.
- Bump the official-model search row generation when the settings panel closes, so in-flight responses cannot populate a reopened panel.
- Require safe-integer event sequences everywhere sequences gate folding or fast-forward comparisons, so contract-external values such as Infinity cannot freeze later flushes or poison the live-event cursor.
- Keep the mixed-workspace upgrade flag through pricing backfills too: repairing costs must never re-enable tail folding of a record whose historical items still belong to another workspace.
- Invalidate in-flight official-model searches whenever the catalog is replaced (manual sync, open-panel refresh, close/reopen), not only when a mapping row is deleted.
- Normalize live-fallback sequences to non-negative safe integers and give positional keys to invalid events, so contract-external sequences cannot overwrite ledger turns or poison the live cursor; ledger rows with non-safe sequences are marked for rebuild.
- Sort the catalog by its stable key before truncating, so models.dev catalogs above the entry cap keep the same models and content hash regardless of upstream object order.
- Enforce the ledger sequence contract (-1 sentinel or non-negative safe integer) when loading persisted records, flag old Infinity/NaN/negative keys and sequences for rebuild, and never clear the rebuild flag during cost repacking or ledger recovery.
- Resolve normalized duplicate catalog entries deterministically (stable sort with conflict groups comparing full content, provider id case-normalized) so enumeration order can no longer change which price survives.
- Extend the ledger sequence contract to every write and read path: oversized numeric keys (past Number.MAX_SAFE_INTEGER) and unsafe numbers in usage/turn data are normalized at the entry points and flagged for rebuild; the rebuild reason is persisted so a source-read failure followed by a restart can never silently reuse a polluted record.
- Persist the rebuild reason for legacy-version and invalid-updated-at records too, not only sequence/workspace damage, so a source-read failure followed by restart cannot fast-path a record that was upgraded in memory.
- Recognise any non-canonical numeric text (floats, exponents, negatives) in old event keys as pollution, and forbid both memory and ledger tail-folding when an incremental log contains invalid sequences anywhere before the fold start.
- Refuse to tail-fold a flush whose log tail does not advance and whose history contains invalid sequences: the whole usage index is rebuilt from source so the in-memory aggregate and the persisted ledger cannot disagree.
- Detect invalid sequences on every dirty flush (not only when the tail did not advance), so a history rewrite followed by a normal appended tail also rebuilds instead of folding stale in-memory rows.
- Persist an invalid-flush-sequence rebuild flag on the stale ledger record before triggering the full rebuild, so a lagging persistence revision cannot fast-path the baseline back to the old data.
- Match Infinity/NaN pollution only as bare whole values, keeping composite keys such as Infinity-session:step:1:1 on the revision fast path.
- Keep the server-persisted pricing auto-sync flag as the single truth: the client stops seeding the draft from its own local UI state, so saving unrelated settings cannot revert the server value.
- Move in-flight official-model search state (timers, sequence guards, results) when mappings are deleted, so a stale response can no longer populate a shifted row.
- Restrict pricing revision bumps to cost-affecting changes: sync attempts and failed attempts no longer invalidate scoped query caches or records cursors, while the client treats pricing changes as a full snapshot refresh so summary costs stay fresh.
- Bucket hourly rows by the local hour boundary at the event's own offset, keeping both repeated hours of a DST fall-back day distinct.
- Add a CI guard that rejects a missing or untracked generated client bundle (`git ls-files --error-unmatch`) before the determinism diff.
- Initialized the durable ledger revision clock and reject persisted ledger records whose `updatedAt` is not finite.
- Require HTTP socket peers to be loopback before accepting a request, including IPv4-mapped loopback addresses.
- Preserve route-specific pricing mappings through the `identityKey` field, while accepting legacy `usageIdentityKey` data.
- Add validated context-tiered model pricing using the request input context; malformed schedules remain unsupported instead of producing a guessed estimate.
- Require `webServer` before Host activation so the dashboard routes cannot silently disappear when the service mounts late.
- Migrate legacy tiered flat cost snapshots to `unsupported`, reject timestamps outside JavaScript's TimeClip range, and exercise the real SessionStore append/flush firehose in runtime smoke tests.
- Require manual npm recovery dispatches to provide and verify the target release tag and full commit SHA.

### Documentation

- Documented the DSH compatibility matrix, the difference between local replayable statistics and provider billing, cache/token examples, and the fixture workflow.

## [1.1.2] - 2026-08-30

### Added

- Added models.dev price catalog synchronization with a persisted last-good cache, optional 6-hour automatic sync, model-only official-vendor matching, explicit model mappings, and manual overrides for authoritative special pricing.
- Added cc-switch-compatible four-bucket cost snapshots: input, output, cache read, and cache write; cost multipliers apply only to the final total.
- Added ledger v3 cost snapshots, zero-cost/unpriced coverage counters, cost fields in scoped query and privacy-safe records responses, cost columns in exports, and a dashboard pricing settings panel.
- Added searchable current-model selectors for mappings and overrides, automatic official model lookup, compact price-field labels, and persisted mapping display recovery.
- Added Token and cost details to model and workspace donut legends and hover menus, including aggregated values for the other bucket.
- Added date-indexed usage and turn queries, revision-scoped snapshot and records caching, debounced official model search, and complete write-chain draining during disposal.

### Fixed

- Preserved DSH's already-normalized fresh input semantics and avoided charging reasoning tokens twice when provider output counts already include completion/thoughts.
- Kept positive historical cost snapshots stable across pricing catalog updates; only unpriced usage is eligible for explicit backfill.
- Fixed saved model mappings reopening with an empty current-model field by deriving the display from the persisted model identity.
- Prevented first live events from being lost during session bootstrap or read failures, and added generation-scoped recovery for baseline/live races.
- Rejected oversized state bodies and malformed alias parameters, reported failed session reads accurately, ignored invalid event timestamps, and kept daily session counts correct after replacements.

## [1.1.1] - 2026-08-29

### Fixed

- Reissued the v1.1 dashboard package under a new patch version for registry compatibility.

## [1.1.0] - 2026-08-28

### Added

- Added structured Provider, requested-model, actual-model, and display-model identity fields while preserving the legacy `model` field.
- Added a backward-compatible ledger v2 adapter; v1 rows are read once, canonicalized, and upgraded before revision skipping resumes.
- Added shared scoped usage and privacy-safe paginated records APIs: `/api/all-usage/query` and `/api/all-usage/records`; query responses now add hourly trend rows for single-day scopes while preserving the existing daily rows.
- Kept workspace, provider, and model filters independent so users can combine all three dimensions in one scope.
- Limited workspace, provider, and model filter options to values used in the selected date range and clear selections that become unavailable after a range change.
- Added unified Workspace, Provider, model, date, and timezone filtering for dashboard aggregates, the fixed 53-week heatmap, trend data, and exports.
- Added a responsive Token trend chart with smooth monotone cubic curves, staged draw animation, selectable input, cache-read, cache-write, output, reasoning, and total series; single-day scopes use hourly buckets while cross-day scopes use daily buckets.
- Added Token-share donut charts with ranked legends to the model and workspace detail panels, including high-contrast remainder segments, animated arc reveals, and cursor-following hover details.
- Added a persistent Request Logs tab with a compact paginated table, selected-row Token detail, opaque row IDs, materialization-source labels, and scoped detail CSV export.
- Optimized Host records pagination with revision-scoped ordering and precomputed identity/date values; optimized Client derived aggregates with memoization and active-tab rendering.

### Fixed

- Prevented model identity collisions caused by parsing display labels containing ` / `.
- Detects truncated or replaced session logs instead of overlaying a newer full rebuild with a stale ledger row.
- Keeps turn counts, call counts, and distinct session counts separately defined in scoped results.
- Keeps complete trend paths visible while per-series reveal animation restarts during live refreshes, preventing the final chart segment from disappearing.
- Reserves the trend chart height during query loading and replaces floating loading text/legend controls with a centered spinner.
- Keeps hover intersection markers static so they do not jump from the SVG origin into position on every hover.
- Reuses one anchored trend tooltip with short position and opacity transitions, avoiding abrupt remounts while switching dates.
- Isolates dashboard render failures behind the sidebar entry so a bad range response cannot remove the usage entry itself.

## [1.0.9] - 2026-08-26

### Added

- Added a lightweight, guarded `/api/all-usage/status` contract with a per-Host instance ID, monotonic stats revision, scan progress, and non-sensitive sync-health counters.
- Added sync-health visibility for revision-skipped sessions, actual log reads, ledger-only recoveries, failures, persistence snapshot availability, and last completed baseline time.
- Added revision-driven Client refresh: after the initial scan, the dashboard polls only lightweight status and fetches the full historical snapshot only when the Host instance or stats revision changes.

### Fixed

- Preserved the last successful usage view after status or full-snapshot failures, exposed a retry action, and added bounded retry backoff instead of silently discarding refresh errors.

## [1.0.8] - 2026-08-23

### Added

- Added a restart read-avoidance cursor: on startup the plugin uses the persisted log revision (via `sessionPersistence.listSnapshots()`, a header-line + stat read) as a per-session change signal. Sessions whose log is unchanged since the last ledger write are applied straight from the durable ledger without reading their full event log; only changed or new sessions are read (incrementally).
- Stored the log revision in each durable ledger record (`lastRevision`); existing rows without it are re-read once and backfilled, so behavior is backward compatible.

### Fixed

- Eliminated the per-session full-event read at restart for unchanged persisted sessions, so DSH restarts no longer re-read every session's history from scratch.

## [1.0.7] - 2026-08-23

### Added

- Added an incremental ledger cursor: baseline rescans reuse the durable ledger as a per-session cursor, so unchanged sessions seed from the ledger instead of re-folding every historical event, and changed sessions fold only the new tail.
- Added an all-zero usage guard: zero-token usage replays no longer overwrite already-recorded turn/step usage, while pure cache-read requests (billable cache hits with no input/output) are still counted.
- Added a structured, machine-readable token semantics declaration (`tokenSemantics.semantics`) to the `/api/all-usage` snapshot: input is fresh (excludes cache), cache and reasoning are separate buckets.

### Fixed

- Reduced startup scan cost on long usage history: sessions whose events are unchanged since the last ledger write are no longer re-folded or rewritten.
- Prevented a live retry of an already-recorded step from double-counting after a fresh-instance seed.

## [1.0.6] - 2026-08-23

### Added

- Added a durable per-session usage ledger written at the awaited `session/flush` boundary.
- Preserved successfully flushed turns and token usage after conversation logs are deleted.
- Added automatic rebuilds from ledger records after session disposal or reconciliation detects missing logs.

### Fixed

- Prevented stale baseline snapshots from overwriting newer flushed ledger records.
- Normalized duplicate ledger keys during hydration and guarded ledger writes during plugin disposal.
- Prevented inactive Cordis timer contexts from escalating into fatal DSH load failures.
- Replaced invalid hyphenated storage unit names with valid underscore names.

## [1.0.5] - 2026-08-20

### Added

- Added custom start/end date ranges across all available historical daily data.
- Kept the heatmap as a fixed latest-53-week view while allowing older range aggregation and CSV export.
- Added distinct session counts for bounded ranges.

### Fixed

- Added baseline retry with backoff after transient session registry failures.
- Stopped in-flight scans and stale polling responses after plugin disposal or refresh races.

## [1.0.4] - 2026-08-19

### Fixed

- Hardened loopback, same-origin, method, and process-token checks for dashboard API routes.
- Allowed same-origin browser balance GET requests that omit `Origin` while retaining token protection.
- Standardized English date buckets, range filters, streaks, heatmap dates, and export timestamps on UTC.

[1.1.3]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.1.3
[1.1.2]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.1.2
[1.1.0]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.1.0
[1.0.9]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.9
[1.0.8]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.8
[1.0.7]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.7
[1.0.6]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.6
[1.0.5]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.5
[1.0.4]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.4

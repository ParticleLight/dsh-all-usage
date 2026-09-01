# Changelog

All notable changes to `dsh-all-usage` are documented here.

## [Unreleased]

### Added

- Make Cost Statistics tier-aware: show expandable official rate schedules and support validated context bands in explicit price overrides.

### Performance

- Avoid rebuilding and writing a clean session's derived ledger at `session/flush`; queue and coalesce dirty records, then drain pending writes during disposal.
- Store derived ledger records in 32 stable-hash JSON units so a session update rewrites only its shard; retain the legacy single-unit migration path.
- Build scoped query and fixed 53-week heatmap results from ingest-time date/workspace/model cubes; use exact BigInt decimal accumulators and a minimal heatmap projection instead of rescanning usage rows or parsing cost strings on cold reads.

### Correctness

- Use the previous ledger cursor for safe append-only tail folding and fall back to a full rebuild when sequence continuity or turn replacement is uncertain.

## [1.1.3] - 2026-08-31

### Added

- Added deterministic usage invariants and a redacted fixture replay command covering failed requests, orphan usage chunks, cache buckets, replacement semantics, and exact expected totals.
- Added a Node 22/24 CI matrix with package-content checks and required real DSH runtime smoke coverage for DSH 0.1.1-rc.1 and 0.1.1-rc.2.
- Added community issue templates for data inconsistencies, plugin startup failures, and cost calculation issues.

### Fixed

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

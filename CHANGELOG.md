# Changelog

All notable changes to `dsh-all-usage` are documented here.

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

[1.0.7]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.7
[1.0.6]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.6
[1.0.5]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.5
[1.0.4]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.4

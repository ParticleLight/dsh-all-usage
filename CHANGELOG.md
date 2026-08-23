# Changelog

All notable changes to `dsh-all-usage` are documented here.

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

[1.0.6]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.6
[1.0.5]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.5
[1.0.4]: https://github.com/ParticleLight/dsh-all-usage/releases/tag/v1.0.4

# Changelog

All notable changes to ezdyndns are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). While the version is below 1.0, a
minor bump may change behaviour; such changes are listed under **Changed**.

## [Unreleased]

## [0.2.0] - 2026-10-31

### Added
- Five DNS providers: Duck DNS, Porkbun, DigitalOcean, Gandi LiveDNS and FreeDNS (afraid.org).
  Porkbun, DigitalOcean and Gandi credentials are checked read-only before saving; Duck DNS and
  FreeDNS are checked with one real update, like deSEC.
- Provider catalog (`backend/services/catalog.js`): one list drives the API's provider check, the
  add and edit forms (including two-key providers and per-record tokens) and credential
  re-verification.
- Push-on-change for FreeDNS: a record whose last good push already set the current IP is skipped,
  with a daily re-assert, because FreeDNS asks clients not to resend an unchanged IP.
- Redesigned dashboard: a dark network-ops layout whose headline states whether every record points
  at the current IP, with panels for the public IP and its address history, record health (state,
  last 24 pushes, last good push, failure streak), services, and a filterable push log.
- Propagation view: a lazily loaded three.js scene with the home IP at the centre and each record on
  a ring, coloured by state; a packet travels to each record after every check. It falls back to a
  server-rendered SVG without WebGL and stays still under reduced motion.
- Edit-service dialog: rename, change the interval, pause or resume, replace the credential, add and
  remove records, delete the service.
- `PATCH /api/services/:id`: partial update. A replaced Cloudflare or deSEC credential is verified
  before saving (`422` on failure); a duplicate name answers `409`.
- `GET /api/updates` accepts `domain_id` and `failed=1`; `limit` is capped at 500.
- `GET /api/domains` (per-record health) and `GET /api/ip-changes` (observed public-IP changes).
- `ip_changes` table, created automatically on boot and capped at the last 200 rows.
- Vendored frontend libraries (htmx 4.0.0, three 0.186.1, Motion 14.3.0, Public Sans and IBM Plex
  Mono 5.3.0) via `scripts/vendor-frontend.sh`, because the Traefik CSP allows no CDN. JavaScript is
  gzipped in memory by the static handler.
- Test preload (`backend/tests/setup.js`) that points every `bun test` run at a temporary database.
- Database tests for `updateService`, `domainHealth`, update filters and service validation.
- MIT license, this changelog, and GitHub Actions workflows for CI, tests and releases.
- `bun run test`, `bun run lint` and `bun run vendor` scripts.

### Changed
- `restartScheduler()` (called after adding, editing, pausing or deleting a service) now only
  reschedules. It no longer runs an immediate check, so a new service waits up to one interval for
  its first push. Use **Check now** or `POST /api/check` to push at once.
- Checks are single-flight: a manual check during a scheduled one joins it instead of starting a
  second run, and restarting the scheduler no longer leaks intervals.
- `biome.json` migrated to the Biome 2 format; the vendored files are excluded from linting.
- Migration `0002-provider-check-in-code` rebuilds `services` without the `provider` CHECK; the API
  validates providers against the catalog instead, so new providers need no table rebuild. Rows
  are copied as they are.
- Docker image on `oven/bun:1.4.4-alpine` (was 1.3.8), installing from `bun.lock` with
  `--frozen-lockfile` so the image gets the tested versions. CI and the test matrix use 1.4.4.
- deadslog 1.3.1 → 2.0.0 (its range is now `^2.0.0` instead of `latest`); indirect dependencies
  refreshed within their ranges.

### Fixed
- Cloudflare credential verification sends `Authorization: Bearer`, so valid API tokens are no
  longer rejected.
- htmx 4 compatibility: form events and request handling use the htmx 4 event names, and domain
  inputs are associated with the add-service form.
- A failed request no longer replaces a panel with its error body; the message shows on the form
  that sent it, and a `401` locks the dashboard again.
- Polling no longer wipes what you are typing in a form.
- Errors from adding a record (duplicate, missing token) now show in the edit dialog.
- Running `bun test` no longer reads or writes the real `db/ezdyndns.db`.

## [0.1.0] - 2026-10-02

### Added
- DDNS updater on Bun, Elysia and `bun:sqlite`, with an in-process scheduler and a public-IP
  fallback chain (ipinfo, ipify, myip, ifconfig.me).
- Namecheap and Cloudflare providers, and a deSEC (dedyn.io) provider with live token verification.
- Credentials are verified before a service is stored (`422` on failure).
- Encrypted credential storage, a management token for the API and dashboard, and optional ntfy
  notifications.
- `schema_migrations` framework for schema changes SQLite cannot `ALTER`.
- htmx dashboard with a provider-aware add-service form.
- Docker image with a healthcheck and a Traefik-ready compose file.

[Unreleased]: https://github.com/c4lyp5o/ezdyndns/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/c4lyp5o/ezdyndns/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/c4lyp5o/ezdyndns/releases/tag/v0.1.0

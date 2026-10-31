# Changelog

All notable changes to ezdyndns are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). From 1.0.0 the public surface is the
HTTP API under `/api`, the environment variables and the database schema: a breaking
change to any of them bumps the major version. Migrations only move forward, so back
up `db/ezdyndns.db` before upgrading.

0.2.0 and 0.3.0 were never tagged; their notes are kept below as the history of what
1.0.0 contains.

## [Unreleased]

## [1.0.0] - 2026-10-31

First stable release: everything since 0.1.0, listed in detail under 0.3.0 and 0.2.0.

### Highlights
- **Dashboard** in a network-ops layout: a headline that says whether every record points at
  your IP, public IP with address history, a three.js propagation view, record health with a
  per-record DNS check, services with an edit dialog, a filterable push log with CSV export.
- **Ten providers**: Namecheap, Cloudflare, deSEC, Duck DNS, Porkbun, DigitalOcean, Gandi,
  FreeDNS (afraid.org), No-IP and any dyndns2 server. A and AAAA records (all but Namecheap).
- **Safer updates**: the public IP needs two sources to agree; rejected credentials hold a
  record until you press Retry; rate limits and repeated failures back off; push-on-change
  providers aren't sent repeat updates.
- **DNS toolbox**: lookups across authoritative and public resolvers, mail checks (MX, SPF,
  DMARC, DKIM) and reverse DNS, in the dashboard and at `/api/tools/*`.
- **Notifications** to ntfy, a webhook, Discord and Gotify, including recovery.
- **Docker image** on `ghcr.io/c4lyp5o/ezdyndns`, with CI, tests on two Bun versions, and tagged
  releases.

### Upgrading from 0.1.0
- Back up `db/ezdyndns.db`. Three migrations run on first boot: `0002` drops the provider CHECK,
  `0003` rebuilds `domains` with record types and holds (ids kept). They were rehearsed on a copy
  of a live database with no rows lost.
- `restartScheduler` no longer runs an immediate check; new and resumed services are pushed
  straight away instead.
- deSEC updates now send the other address family as `preserve`. Before, an update could delete
  the record's AAAA. Check any deSEC record that should have one.
- The HTTP API is backward compatible with 0.1.0; everything new is additive.

## [0.3.0] - 2026-10-31 (not tagged)

### Added
- DNS toolbox panel and `/api/tools/*`: lookups of any common record type across the zone's
  authoritative nameservers and Cloudflare, Google and Quad9; mail checks (MX, SPF with the
  10-lookup limit counted through includes, DMARC, DKIM by selector); reverse DNS with forward
  confirmation.
- Resolution check: each record shows whether its nameservers and public resolvers answer with the
  IP last pushed (Resolves, Propagating, Mismatch, Unknown). Clicking it opens the lookup.
- AAAA records for every provider except Namecheap, with IPv6 detection while one is active.
- No-IP and generic dyndns2 providers (custom update server), both push-on-change.
- Holds and back-off: a hard failure (rejected credentials, unknown host, dyndns2 `badauth`/`abuse`)
  holds the record until Retry and sends one "needs attention" notification; rate limits wait as
  asked; three failures in a row back off exponentially up to an hour.
- Push / Retry per record, showing the provider's reply.
- Edit a record's host, domain, type or token in place.
- Skipped cycles are logged (`ok = 2`) and drawn as outlined ticks; the log gains a Sent filter
  and CSV export (`GET /api/updates.csv`).
- Notifications to a generic webhook, Discord and Gotify alongside ntfy, plus "recovered",
  "needs attention" and "IP check inconclusive" events.
- `/api/health` adds `records`, `failing`, `held` and `check_error`.
- `EZDYNDNS_KEEP_SUCCESS_DAYS`, `EZDYNDNS_KEEP_FAILURE_DAYS`, `EZDYNDNS_CONTACT`,
  `EZDYNDNS_RESOLVE_CHECKS`.

### Changed
- The public IP needs two sources to agree (all are asked at once); a lone answer counts only if it
  matches the last known IP. Otherwise the cycle pushes nothing.
- Each service is pushed on its own interval instead of every service at the shortest one; an IP
  change still pushes everything at once.
- A service is pushed right after it is added or resumed, and a record right after it is added or
  edited, instead of waiting for the next interval.
- Migration `0003-records-holds-settings` rebuilds `domains` (ids kept) with `record_type` and hold
  columns and a UNIQUE that includes the type, and adds `services.options`. New `resolutions` table.
- "Last good push" moved into each record's sub-line to make room for the DNS column.

### Fixed
- deSEC updates no longer delete the record's AAAA (or A): the other address family is sent as
  `preserve`. Before, an update without an IPv6 parameter deleted the AAAA unless it arrived over IPv6.
- Deleting a service or record now deletes its history; foreign keys are off on this connection, so
  `ON DELETE CASCADE` never ran.
- Cloudflare apex records (`@`) were looked up as `@.domain`.
- Long TXT records (SPF, DKIM) are read whole; Bun's `resolveTxt` keeps only the first 255-byte string.
- The scheduler's startup log no longer prints `interval nonems`; three old lint warnings are fixed.

## [0.2.0] - 2026-10-31 (not tagged)

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

[Unreleased]: https://github.com/c4lyp5o/ezdyndns/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/c4lyp5o/ezdyndns/releases/tag/v1.0.0

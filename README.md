# 🌐 ezdyndns

[![CI](https://github.com/c4lyp5o/ezdyndns/actions/workflows/ci.yml/badge.svg)](https://github.com/c4lyp5o/ezdyndns/actions/workflows/ci.yml)
[![Test](https://github.com/c4lyp5o/ezdyndns/actions/workflows/test.yml/badge.svg)](https://github.com/c4lyp5o/ezdyndns/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Self-hosted dynamic DNS updater. Watches your public IP and pushes A-record
updates to DNS providers when it changes. Rewrite of the 2024 `cdyndns`
concept on the ez stack.

## Stack
- Bun + Elysia backend, `bun:sqlite` (no ORM, WAL mode)
- In-process scheduler (`setInterval` + jitter) — no worker process; a DDNS
  check is one ~200ms HTTP call every N seconds, it never blocks the API
- htmx 4 frontend with no build step, served by the same process: server-rendered
  fragments (`backend/routes/partials.js`), `app.js` for htmx glue, and `ui.js` (ES module)
  for Motion feedback and a lazily loaded three.js view of the IP → record links
- Third-party files are vendored into `frontend/public/vendor/` by `scripts/vendor-frontend.sh`
  (pinned versions; three/motion tree-shaken with `bun build`). The Traefik CSP is
  `script-src 'self'; font-src 'self'`, so nothing loads from a CDN. JS is gzipped in-process.
- deadslog logging, Biome lint

## Providers
The list lives in `backend/services/catalog.js` (labels, credential fields, form copy); each
provider's adapter is in `backend/services/`. Adding one is a catalog entry plus an adapter.

| Provider | Credential | Verified before saving | Notes |
|---|---|---|---|
| **namecheap** | Dynamic DNS password (per domain, optional per record) | No, on the first push | dynamicdns.park-your-domain.com |
| **cloudflare** | API token (Zone · DNS · Edit) | Yes | Finds the zone, creates or patches the A record |
| **dedyn** (deSEC) | Token scoped `domain/update/ttl/ip4` | Yes, one real update | Details below |
| **duckdns** | Account token | Yes, one real update | Records are `<subname>.duckdns.org` |
| **porkbun** | API key + secret API key | Yes, read-only | The domain must have API access turned on |
| **digitalocean** | Personal access token (domain read/update) | Yes, read-only | Creates the record if missing, TTL 60 s |
| **gandi** | Personal access token (LiveDNS) | Yes, read-only | PUTs the rrset, TTL 300 s (the minimum) |
| **afraid** (FreeDNS) | The record's update URL or token | Yes, one real update | One token per record; pushes only when the IP changes, plus once a day |
| **noip** (No-IP) | Username + password, or a DDNS key | Yes, one real update | dyndns2; push-on-change; set `EZDYNDNS_CONTACT` for the User-Agent |
| **dyndns2** (other) | Username + password, plus the update server | Yes, one real update | Any dyndns2 server (Dynu, Dyn, routers); push-on-change |

Every provider except Namecheap can also keep an **AAAA** record current: add the record with type AAAA
and ezdyndns detects the public IPv6 (api6.ipify.org, v6.ident.me) only while such a record is active.

Read-before-write providers (Cloudflare, Porkbun, DigitalOcean, Gandi) skip the write when the
record already holds the IP. FreeDNS publishes no API spec; the adapter follows ddclient's
`freedns` protocol (`update.php?<token>&address=<ip>`, success when the reply says `Updated`) and
refuses a reply that names a different host, so a token copied from another record can't move it.

**deSEC details.** username = deSEC STS token, sent as an
  `Authorization: Token …` header. Use a dedicated token scoped `domain/update/ttl/ip4` with TTL ≤
  the check interval. The token is verified against the dynDNS update endpoint itself before the
  service is stored (200 + `good` = valid): deSEC's `GET /api/v1/tokens/self/` answers 404 for
  valid update-scoped tokens too, so it cannot be used as a check. Updates go to `https://update.dedyn.io/ezdyndns`
  with the detected IP passed explicitly as `myipv4=` (or `myipv6=` for an AAAA record), and the other
  family always as `preserve`: deSEC deletes the AAAA (or A) when its parameter is missing and the
  request didn't arrive over that family (any path is allowed except `.ico`/`.png`).
  A same-IP update re-asserts the record every cycle like the other providers. deSEC rate-limits
  the dynDNS endpoint at 2 calls / 2 min per account (sliding window, `429` + `Retry-After`) —
  a 300s interval spends exactly 1 of those; 429 is reported as retry-later, never as bad credentials.

Credentials for **all** providers are validated before the service row is created (`422` +
`credential check failed: …` on `POST /api/services` and the htmx form path), so a bad token
can't sit failing silently in the update log.

## Run
```bash
bun install                  # from repo root
./scripts/gen-env.sh         # generates backend/.env with the two required secrets
bun run dev                  # backend on 127.0.0.1:5070, UI at http://127.0.0.1:5070/
```

`backend/.env.example` documents every variable — copy it to `backend/.env`
and fill in the two required values (`EZDYNDNS_ENCRYPTION_KEY`,
`EZDYNDNS_TOKEN`); the server refuses to boot without them. See comments in
that file for generation commands. The UI asks for the management token on
first load and stores it in `sessionStorage.ezdyndns_token`; nothing renders
or fetches until it's unlocked.

## Development
```bash
bun run test                 # backend tests; a preload forces a temporary database
bun run lint                 # Biome 2.2.3 (vendored files are excluded)
bun run vendor               # re-download the pinned frontend libraries into frontend/public/vendor/
```

Branches: `master` holds released code, `development` collects finished work, and changes are made
on `feat/*` or `fix/*` branches cut from `development`. Pull requests go into `development`;
`development` is merged into `master` for a release.

Never point a local run at the `db/` a running container uses: set `EZDYNDNS_DB` to a scratch path.

## Releases
1. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new version heading and set the same
   version in `package.json`.
2. Merge `development` into `master` and tag it: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow runs the tests, checks that the tag matches `package.json`, publishes
   `ghcr.io/c4lyp5o/ezdyndns:<version>` (plus `<major>.<minor>` and `latest`), and creates a GitHub
   release with that version's changelog section as its notes.

CI (`ci.yml`) lints, checks that every vendored file the page loads is committed, and builds and
smoke-tests the Docker image on pushes and pull requests to `master` and `development`. The
**Test** workflow (`test.yml`) runs `bun test` on Bun 1.4.4 (the image's version) and the latest Bun.

## Deploy (Docker)
```bash
docker compose build
docker compose up -d
```
The compose file expects an external `traefik_default` network and a
`traefik.http.routers.ezdyndns.rule=Host(...)` host. Set `EZDYNDNS_HOSTNAME`
(and `EZDYNDNS_HOST=0.0.0.0`) in the environment or a `.env` beside the
compose file. `db/` and `logs/` are bind-mounted, so the state survives
rebuilds — the container must run as a uid that can write those directories.

## How it works
- One loop ticks at the shortest active interval. Each tick asks all four IP sources at once
  (ipinfo, ipify, myip, ifconfig.me) and needs **two to agree**; a lone answer is accepted only if it
  matches the last known IP. Otherwise nothing is pushed that cycle, the hero says why, and one
  "IP check inconclusive" notification goes out per hour.
- A service is pushed when its own `interval_sec` is up, or at once when the IP changes, or right
  after it is added, resumed or given a record. Each result is logged in `updates` with old/new IP,
  result (ok / failed / skipped) and provider detail. Namecheap returns `ErrCount 0` even for a
  same-IP update (verified live), so most providers keep asserting the record every cycle;
  push-on-change providers (FreeDNS, No-IP, dyndns2) skip until the IP changes or a day passes.
- **Holds and back-off.** Adapters say whether a failure is *hard* (bad credentials, host not on the
  account, `badauth`/`abuse`) or *retry later* (rate limit, `911`). A hard failure holds the record
  until you fix it and press **Retry**, and sends one "needs attention" notification; a rate limit
  waits as long as the provider asked; three ordinary failures in a row back off exponentially (up
  to an hour). An IP change clears time-based waits.
- **Resolution check.** After pushes and every 10 minutes, each record is looked up at the zone's own
  nameservers and at Cloudflare, Google and Quad9: *Resolves*, *Propagating* (authoritative is right,
  a resolver still caches the old IP), *Mismatch* (authoritative says something else) or *Unknown*.
  Set `EZDYNDNS_RESOLVE_CHECKS=0` where outbound DNS is blocked.
- Every outbound call has a 5-10s `AbortSignal.timeout` — a hung provider
  can't wedge the scheduler.
- Schema changes SQLite can't `ALTER` (CHECK constraints) run as recorded
  migrations in `schema_migrations` on boot — see `MIGRATIONS` in `backend/db.js`.
- The `updates` log is pruned daily (successes 3 days, failures 30, skipped cycles 1; the first two
  via `EZDYNDNS_KEEP_SUCCESS_DAYS` / `EZDYNDNS_KEEP_FAILURE_DAYS`).
- Notifications go to any of ntfy, a generic JSON webhook, Discord and Gotify (see
  `backend/.env.example`): IP changed, update failed (at most hourly), recovered, needs attention,
  IP check inconclusive, check loop stalled. An unauthenticated `GET /api/health` (counts only, no
  names) backs the container healthcheck.

## Toolbox
The dashboard's Toolbox panel (and `/api/tools/*`) answers the usual DNS questions without leaving it:
- **DNS lookup** — A, AAAA, CNAME, MX, TXT, NS, SOA, CAA, SRV or PTR, asked of the zone's
  authoritative nameservers and of Cloudflare, Google and Quad9 side by side, with TTLs and a note
  when they disagree. A record's DNS pill opens this lookup compared with the IP last pushed.
- **Mail checks** — MX hosts and their addresses; SPF (duplicates, the 10-lookup limit counted
  through includes, `+all`/`?all`, missing `all`); DMARC policy and reporting; a DKIM key by selector.
- **Reverse DNS** — PTR names for an address, each forward-confirmed.

TXT answers are read with a small DNS-over-TCP query of ezdyndns's own: Bun's `resolveTxt` keeps only
the first 255-byte string of a record, which cuts long SPF and DKIM records short.

## API
- `GET  /api/status` — current IP, last check, services (passwords masked)
- `GET  /api/health` — unauthenticated: `ok`, IP, check age, `records`/`failing`/`held` counts, last check error
- `GET  /api/updates?limit=25&domain_id=&failed=1` — update log, optionally one record / failures only
- `GET  /api/updates.csv?domain_id=&failed=1` — the whole filtered log as CSV
- `GET  /api/domains` — per-record health: last 24 pushes, last success, consecutive failures
- `GET  /api/ip-changes?limit=20` — observed public-IP changes (kept apart from the pruned log)
- `POST /api/services` — `{ name, provider, username?, password?, interval_sec?, domains? }`; `provider` is one of
  `namecheap cloudflare dedyn duckdns porkbun digitalocean gandi afraid noip dyndns2`. Porkbun takes the API
  key as `username` and the secret as `password`; FreeDNS and Namecheap take their key as `password`;
  dyndns2 also takes `server`. Each domain may set `record_type` (`A` default, or `AAAA`).
- `POST /api/services/:id/domains` — `{ hostname, domainname, record_type?, password? }`; `password` is the
  record's own Namecheap password or FreeDNS token (required for a FreeDNS service's second and later records)
- `PATCH /api/services/:id/domains/:domainId` — edit a record in place; clears any hold
- `DELETE /api/services/:id/domains/:domainId` — also deletes the record's history
- `POST /api/domains/:id/push` — push one record now, ignoring holds; returns the provider's reply
- `GET  /api/tools/lookup?name=&type=`, `/api/tools/mail?domain=&selector=`, `/api/tools/reverse?ip=` — the Toolbox, as JSON
- `PATCH /api/services/:id` — `{ name?, interval_sec?, status?, username?, password?, server? }`; provider is fixed,
  a replaced credential is verified first (`422` on failure), a duplicate name is `409`
- `PUT  /api/services/:id/status` — `{ status: active|paused }`
- `DELETE /api/services/:id`
- `POST /api/check` — force an IP check + update cycle now

## Design notes (why no worker like eziarr)
eziarr runs a separate worker process because it does long, parallel,
load-predictable-bad downloads. ezdyndns does one short HTTP GET per interval
and provider calls only on actual IP change — pure async I/O. Process
separation would only add an IPC layer for state that already lives in SQLite.

## License
[MIT](LICENSE). Vendored third-party files keep their own licenses, listed in
`frontend/public/vendor/LICENSES.txt`. See [CHANGELOG.md](CHANGELOG.md) for release history.

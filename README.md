# 🌐 ezdyndns

Self-hosted dynamic DNS updater. Watches your public IP and pushes A-record
updates to DNS providers when it changes. Rewrite of the 2024 `cdyndns`
concept on the ez stack.

## Stack
- Bun + Elysia backend, `bun:sqlite` (no ORM, WAL mode)
- In-process scheduler (`setInterval` + jitter) — no worker process; a DDNS
  check is one ~200ms HTTP call every N seconds, it never blocks the API
- Single-file htmx frontend (no build step, served by the same process)
- deadslog logging, Biome lint

## Providers
- **namecheap** — dynamicdns.park-your-domain.com DDNS API (password = your DDNS key)
- **cloudflare** — API v4 (username = API token; finds zone, creates or patches the A record)

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
- On boot and every `interval_sec` per active service: fetch public IP from a
  fallback chain (ipinfo → ipify → myip → ifconfig.me), first success wins.
- Every cycle pushes to every active service × domain; each result is logged
  into `updates` with old/new IP, ok flag and provider detail. Namecheap
  returns `ErrCount 0` even for a same-IP update (verified live), so a DDNS
  daemon keeps asserting the record rather than assuming it is still correct.
- Every outbound call has a 5-10s `AbortSignal.timeout` — a hung provider
  can't wedge the scheduler.
- The `updates` log is pruned daily (successes 3 days, failures 30 days) so
  per-cycle logging doesn't grow the DB without bound.
- Optional: set `EZDYNDNS_NTFY_URL` to get an ntfy push on IP change, update
  failure, or a stalled check loop. An unauthenticated `GET /api/health`
  (returns only `ok`/`ip`/age) backs the container healthcheck.

## API
- `GET  /api/status` — current IP, last check, services (passwords masked)
- `GET  /api/updates?limit=25` — update log
- `POST /api/services` — `{ name, provider, username?, password?, interval_sec?, domains? }`
- `POST /api/services/:id/domains` — `{ hostname, domainname }`
- `DELETE /api/services/:id/domains/:domainId`
- `PUT  /api/services/:id/status` — `{ status: active|paused }`
- `DELETE /api/services/:id`
- `POST /api/check` — force an IP check + update cycle now

## Design notes (why no worker like eziarr)
eziarr runs a separate worker process because it does long, parallel,
load-predictable-bad downloads. ezdyndns does one short HTTP GET per interval
and provider calls only on actual IP change — pure async I/O. Process
separation would only add an IPC layer for state that already lives in SQLite.
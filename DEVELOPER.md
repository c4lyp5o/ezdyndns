# Developing ezdyndns

Bun backend (`backend/`) with a plain HTML/JS frontend in `frontend/public/` (vendored libraries under `frontend/public/vendor`).

## Commands

Run from the repo root with [Bun](https://bun.sh).

| Task | Command |
| --- | --- |
| Install every package | `bun run install` |
| Run the dev servers | `bun run dev` |
| Run the test suite | `bun run test` |
| Lint with Biome | `bun run lint` |
| Apply Biome's safe fixes | `bun run lint:fix` |
| Start in production (PM2 where configured) | `bun run start` |

## Tests

`bun run test` runs the backend `bun:test` suite.

## Linting

[Biome](https://biomejs.dev) 2.6.8 is the only linter. It is pinned at the repo root, so run it from there: `bun run lint` checks, `bun run lint:fix` applies safe fixes. Configuration is `biome.json`; `biome.json` also sets the formatting rules (`bunx biome check --write .` applies them). CI runs the same command.

## Branches and releases

There are two long-lived branches:

| Branch | Role |
| --- | --- |
| `development` | Integration branch. Branch from it (`feat/…`, `fix/…`, `chore/…`) and open every PR against it. |
| `master` | Released code. Only `development` is merged into it, by PR. |

No other long-lived branches (`main`, `dev`, `staging`, …) are kept; delete feature branches once merged.

To release: bump the version in `package.json` and `backend/package.json`, move the `[Unreleased]` notes in `CHANGELOG.md` under `## [x.y.z] - YYYY-MM-DD`, then merge `development` into `master`. Tag `vX.Y.Z` on `master`; `release.yml` pushes the GHCR image. `compose.yml` deploys that released image.

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`fix(scope): …`) with a body that explains why. Add a `CHANGELOG.md` line under `[Unreleased]` for anything a user would notice. Every behaviour change needs a test; a bug fix needs one that fails without the fix.

## Docker

The image is built from `Dockerfile` on `oven/bun:1.4.5-alpine`. Keep the Bun version there and `bun-version` in `.github/workflows/` in step, and smoke-test a locally built image (`docker build -t ezdyndns .`) after changing either.

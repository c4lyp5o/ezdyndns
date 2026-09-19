# ezdyndns — DDNS updater for Calypso's domains
# Static htmx frontend + Elysia/Bun backend, no build step.
FROM oven/bun:1.3.8-alpine

WORKDIR /app

# tzdata for Asia/Kuala_Lumpur timestamps, curl for the healthcheck
RUN apk add --no-cache tzdata curl
ENV TZ=Asia/Kuala_Lumpur

# The base image already ships a non-root user 'bun' at uid/gid 1000:1000 with
# home /home/bun. That is exactly the host user's uid, so bind-mounted db/ and
# logs/ (owned by uid 1000 on the host) stay writable — a different uid here
# cannot write SQLite (SQLITE_READONLY) and this box has no rootless remapping.
# Reuse it rather than adding a user with a colliding uid.
ENV PATH="/home/bun/.bun/bin:${PATH}"

# Dependencies first so source edits don't bust the layer cache
COPY backend/package.json ./backend/
RUN cd backend && bun install --production

COPY backend ./backend
COPY frontend ./frontend
COPY package.json ./
COPY ecosystem.config.js ./

# Writable runtime paths (sqlite db, logs) owned by the app user
RUN mkdir -p /app/db /app/logs \
	&& chown -R bun:bun /app

USER bun

# PM2 as the app user so it runs without root
RUN BUN_INSTALL_BIN=/home/bun/.bun/bin bun add -g pm2

EXPOSE 5070

# /health is unauthenticated by design so this works without the API token
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
	CMD curl -fsS http://127.0.0.1:5070/api/health || exit 1

CMD ["bun", "start"]

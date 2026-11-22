# ez standard Dockerfile: an Alpine runtime (the htmx frontend is static,
# so there is no build stage) that runs as the unprivileged `bun` user (uid 1000) with a wget
# healthcheck. Keep the Bun version in step with `bun-version` in .github/workflows.

# ---- runtime ----
FROM oven/bun:1.4.5-alpine
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="ezdyndns" \
	org.opencontainers.image.source="https://github.com/c4lyp5o/ezdyndns" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="$APP_VERSION"
RUN apk add --no-cache tzdata
ENV TZ=Asia/Kuala_Lumpur \
	NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=5070
WORKDIR /app
# pm2-runtime supervises the processes; installed as root into /opt/bun, run as bun.
ENV BUN_INSTALL=/opt/bun PATH="/opt/bun/bin:${PATH}"
RUN bun add -g pm2
COPY backend/package.json backend/bun.lock ./backend/
RUN cd backend && bun install --production --frozen-lockfile --ignore-scripts
COPY backend ./backend
COPY frontend ./frontend
COPY package.json ecosystem.config.js ./
RUN mkdir -p /app/db /app/logs && chown -R bun:bun /app/db /app/logs
USER bun
EXPOSE 5070
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
	CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["bun", "start"]

import { Elysia } from "elysia";
import { getServices, getService, getDomains, createService, addDomain, deleteDomain, deleteService, setStatus, recentUpdates, getState, sanitizeService } from "../db";
import { restartScheduler, stopScheduler, checkOnce } from "../scheduler";
import logger from "../logger";

import config from "../config";

const requireAuth = (app) =>
	app.onBeforeHandle(({ headers, set }) => {
		if (headers["x-api-token"] !== config.apiToken) {
			set.status = 401;
			return { message: "unauthorized" };
		}
	});

export const api = new Elysia({ prefix: "/api" })
	// /health is UNauthenticated by design (no data beyond ok/ip/age) so
	// uptime monitors and docker healthchecks can poll it without a token.
	.get("/health", () => {
		const lastCheck = getState("last_check")?.value;
		const active = getServices().some((s) => s.status === "active");
		const staleMs = lastCheck ? Date.now() - new Date(lastCheck).getTime() : Infinity;
		// stale = no successful check within 3× the shortest interval (min 10 min)
		const intervalSec = Math.min(...getServices().map((s) => s.interval_sec).concat(600));
		const stale = active && staleMs > Math.max(3 * intervalSec * 1000, 10 * 60 * 1000);
		return {
			ok: !stale,
			active_services: getServices().filter((s) => s.status === "active").length,
			ip: getState("last_ip")?.value ?? null,
			last_check: lastCheck ?? null,
			stale_seconds: Number.isFinite(staleMs) ? Math.round(staleMs / 1000) : null,
		};
	})
	.use(requireAuth)
	.get("/status", () => {
		const services = getServices().map(sanitizeService);
		return {
			ip: getState("last_ip")?.value ?? null,
			last_check: getState("last_check")?.value ?? null,
			services,
		};
	})
	.get("/updates", ({ query }) => recentUpdates(Number(query.limit) || 25))
	.post("/services", async ({ body, set }) => {
		const { name, provider, username, password, interval_sec, domains } = body;
		if (!name || !provider) {
			set.status = 400;
			return { message: "name and provider are required" };
		}
		if (!["namecheap", "cloudflare"].includes(provider)) {
			set.status = 400;
			return { message: "provider must be namecheap or cloudflare" };
		}
		const id = createService({ name, provider, username, password, interval_sec });
		for (const d of domains ?? []) {
			if (d.hostname && d.domainname) addDomain(id, d);
		}
		restartScheduler();
		set.status = 201;
		return { id };
	})
	.post("/services/:id/domains", ({ params, body, set }) => {
		const id = Number(params.id);
		if (!getService(id)) {
			set.status = 404;
			return { message: "service not found" };
		}
		if (!body.hostname || !body.domainname) {
			set.status = 400;
			return { message: "hostname and domainname are required" };
		}
		addDomain(id, body);
		return { ok: true };
	})
	.delete("/services/:id/domains/:domainId", ({ params, set }) => {
		deleteDomain(Number(params.id), Number(params.domainId));
		return { ok: true };
	})
	.delete("/services/:id", ({ params, set }) => {
		if (!getService(Number(params.id))) {
			set.status = 404;
			return { message: "service not found" };
		}
		deleteService(Number(params.id));
		restartScheduler();
		return { ok: true };
	})
	.put("/services/:id/status", ({ params, body, set }) => {
		const id = Number(params.id);
		if (!getService(id)) {
			set.status = 404;
			return { message: "service not found" };
		}
		if (!["active", "paused"].includes(body.status)) {
			set.status = 400;
			return { message: "status must be active or paused" };
		}
		setStatus(id, body.status);
		restartScheduler();
		return { ok: true };
	})
	.post("/check", async () => {
		const result = await checkOnce();
		return result;
	});
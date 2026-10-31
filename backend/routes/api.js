import { Elysia } from "elysia";
import { isIP } from "node:net";
import {
	addDomain,
	countUpdates,
	createService,
	deleteDomain,
	deleteService,
	domainHealth,
	getDomain,
	getDomains,
	getService,
	getServices,
	getState,
	recentIpChanges,
	recentUpdates,
	recordCounts,
	sanitizeService,
	serviceOptions,
	setStatus,
	updateDomain,
	updateService,
} from "../db";
import { checkOnce, pushDomainNow, pushServiceSoon, restartScheduler } from "../scheduler";
import { cleanName, lookup, mailReport, reverseReport, TYPES } from "../services/dnstools";
import { duckSubname } from "../services/duckdns";
import { CATALOG, PROVIDERS, verifyCredentialChange, verifyProvider } from "../services/providers";

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
			// Counts only: records failing their last push, and held after a hard error or back-off.
			...recordCounts(),
			check_error: getState("last_check_error")?.value || null,
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
	.get("/updates", ({ query }) =>
		recentUpdates(Math.min(Number(query.limit) || 25, 500), {
			domainId: query.domain_id,
			failedOnly: query.failed === "1" || query.failed === "true",
		}),
	)
	// The whole filtered log as CSV (the dashboard's Export button).
	.get("/updates.csv", ({ query, set }) => {
		const filter = {
			domainId: query.domain_id || null,
			failedOnly: query.failed === "1" || query.result === "failed",
		};
		set.headers["content-type"] = "text/csv; charset=utf-8";
		set.headers["content-disposition"] = 'attachment; filename="ezdyndns-pushes.csv"';
		return updatesCsv(recentUpdates(countUpdates(filter) || 1, filter));
	})
	// Per-record health: last pushes, last success, consecutive failures.
	.get("/domains", () => ({ ip: getState("last_ip")?.value ?? null, domains: domainHealth() }))
	.get("/ip-changes", ({ query }) => recentIpChanges(Math.min(Number(query.limit) || 20, 200)))
	.post("/services", async ({ body, set }) => {
		const { name, provider, username, password, interval_sec, domains } = body;
		const options = settingsFrom(provider, body);
		if (!name || !provider) {
			set.status = 400;
			return { message: "name and provider are required" };
		}
		if (!PROVIDERS.includes(provider)) {
			set.status = 400;
			return { message: `provider must be one of: ${PROVIDERS.join(", ")}` };
		}
		// Validate credentials BEFORE storing anything — a bad deSEC/CF token
		// would otherwise sit silently failing every interval in the update log.
		const first = domains?.[0];
		for (const d of domains ?? []) {
			const problem = validateRecord({ provider }, d, 0);
			if (problem) {
				set.status = 400;
				return { message: problem };
			}
		}
		const check = await verifyProvider({
			provider,
			username,
			password,
			options,
			hostname: first?.hostname,
			domainname: first?.domainname,
		});
		if (!check.ok) {
			set.status = 422;
			return { message: `credential check failed: ${check.detail}` };
		}
		const id = createService({ name, provider, username, password, interval_sec, options });
		for (const d of domains ?? []) {
			if (d.hostname && d.domainname) addDomain(id, d);
		}
		restartScheduler();
		pushServiceSoon(id);
		set.status = 201;
		return { id };
	})
	// Partial edit. Provider is fixed (it decides what the credentials mean);
	// a replaced credential is verified before anything is written.
	.patch("/services/:id", async ({ params, body, set }) => {
		const id = Number(params.id);
		const service = getService(id);
		if (!service) {
			set.status = 404;
			return { message: "service not found" };
		}
		const problem = validateServiceEdit(body ?? {});
		if (problem) {
			set.status = 400;
			return { message: problem };
		}
		const check = await verifyCredentialChange(service, getDomains(id)[0], body);
		if (check && !check.ok) {
			set.status = 422;
			return { message: `credential check failed: ${check.detail}` };
		}
		try {
			updateService(id, { ...body, options: mergedSettings(service, body) });
		} catch (err) {
			if (String(err.message).includes("UNIQUE")) {
				set.status = 409;
				return { message: "a service with that name already exists" };
			}
			throw err;
		}
		restartScheduler();
		if (body.status === "active" && service.status !== "active") pushServiceSoon(id);
		return sanitizeService(getService(id));
	})
	.post("/services/:id/domains", ({ params, body, set }) => {
		const id = Number(params.id);
		if (!getService(id)) {
			set.status = 404;
			return { message: "service not found" };
		}
		const problem = validateRecord(getService(id), body ?? {}, getDomains(id).length);
		if (problem) {
			set.status = 400;
			return { message: problem };
		}
		const domainId = addDomain(id, body);
		pushDomainSoon(domainId);
		return { ok: true, id: domainId };
	})
	// Edit a record in place: { hostname, domainname, record_type?, password? }.
	.patch("/services/:id/domains/:domainId", ({ params, body, set }) => {
		const service = getService(Number(params.id));
		const domain = getDomain(Number(params.domainId));
		if (!service || !domain || domain.service_id !== service.id) {
			set.status = 404;
			return { message: "record not found" };
		}
		const problem = validateRecord(service, { ...body, password: body?.password || domain.password }, 0);
		if (problem) {
			set.status = 400;
			return { message: problem };
		}
		try {
			updateDomain(service.id, domain.id, body);
		} catch (err) {
			if (String(err.message).includes("UNIQUE")) {
				set.status = 409;
				return { message: "that record already exists on this service" };
			}
			throw err;
		}
		pushDomainSoon(domain.id);
		return { ok: true };
	})
	.delete("/services/:id/domains/:domainId", ({ params }) => {
		deleteDomain(Number(params.id), Number(params.domainId));
		return { ok: true };
	})
	// Push one record now, ignoring holds; answers with the provider's reply.
	.post("/domains/:id/push", async ({ params, set }) => {
		if (!getDomain(Number(params.id))) {
			set.status = 404;
			return { message: "record not found" };
		}
		const { ok, detail, hard, retryAfter } = await pushDomainNow(Number(params.id));
		return { ok, detail, hard: Boolean(hard), retry_after: retryAfter ?? null };
	})
	// DNS toolbox: the same lookups the dashboard's Toolbox panel shows.
	.get("/tools/lookup", async ({ query, set }) => {
		const input = toolQuery(query);
		if (input.error) {
			set.status = 400;
			return { message: input.error };
		}
		return lookup(input.name, input.type);
	})
	.get("/tools/mail", async ({ query, set }) => {
		const domain = cleanName(query.domain);
		const selector = query.selector ? cleanName(`${query.selector}.x`)?.slice(0, -2) : null;
		if (!domain || (query.selector && !selector)) {
			set.status = 400;
			return { message: "domain (and selector, if given) must be valid DNS names" };
		}
		return mailReport(domain, selector);
	})
	.get("/tools/reverse", async ({ query, set }) => {
		if (!isIP(String(query.ip ?? ""))) {
			set.status = 400;
			return { message: "ip must be an IPv4 or IPv6 address" };
		}
		return reverseReport(query.ip);
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
		if (body.status === "active") pushServiceSoon(id);
		return { ok: true };
	})
	.post("/check", async () => {
		const result = await checkOnce();
		return result;
	});
// A record added to an existing service. Returns a message, or null when valid.
export function validateRecord(service, { hostname, domainname, password, record_type }, existing = 0) {
	if (!hostname || !domainname) return "Host and domain are both required.";
	if (record_type && !["A", "AAAA"].includes(record_type)) return "Record type must be A or AAAA.";
	if (record_type === "AAAA" && !CATALOG[service.provider]?.ipv6)
		return `${CATALOG[service.provider]?.label ?? service.provider} can't update AAAA records.`;
	const fqdn = hostname === "@" ? domainname : `${hostname}.${domainname}`;
	if (!cleanName(fqdn.replace(/^\*\./, "x."))) return `${fqdn} isn't a valid DNS name.`;
	if (service.provider === "duckdns" && !duckSubname({ hostname, domainname }))
		return "Duck DNS records are <subname>.duckdns.org: host is the subname, domain is duckdns.org.";
	// The service's own token belongs to its first record; every other record
	// needs its own (FreeDNS tokens are per record).
	if (CATALOG[service.provider]?.perRecord?.required && existing > 0 && !password)
		return `${CATALOG[service.provider].label} needs this record's own update token.`;
	return null;
}

export function validateServiceEdit({ name, interval_sec, status }) {
	if (name !== undefined && !String(name).trim()) return "name cannot be empty";
	if (interval_sec !== undefined && interval_sec !== "" && !(Number(interval_sec) >= 60))
		return "interval_sec must be at least 60";
	if (status !== undefined && status !== "" && !["active", "paused"].includes(status))
		return "status must be active or paused";
	return null;
}

// Provider settings (non-secret options such as the dyndns2 server) from a request body.
export function settingsFrom(provider, body) {
	const names = (CATALOG[provider]?.settings ?? []).map((f) => f.name);
	return Object.fromEntries(names.filter((k) => body?.[k]).map((k) => [k, String(body[k]).trim()]));
}

// An edit's settings merged over the stored ones; undefined when nothing changed.
export function mergedSettings(service, body) {
	const changed = settingsFrom(service.provider, body);
	return Object.keys(changed).length ? { ...serviceOptions(service), ...changed } : undefined;
}

// Push one record in the background after it is added or edited.
export function pushDomainSoon(domainId) {
	pushDomainNow(domainId).catch(() => {});
}

// name + type for a toolbox lookup; PTR also takes an IP address.
export function toolQuery(query) {
	const type = String(query.type ?? "A").toUpperCase();
	if (!TYPES.includes(type)) return { error: `type must be one of ${TYPES.join(", ")}` };
	const raw = String(query.name ?? "").trim();
	if (type === "PTR" && isIP(raw)) return { name: raw, type };
	const name = cleanName(raw);
	return name ? { name, type } : { error: "name must be a valid DNS name" };
}

const csvCell = (v) => {
	const s = String(v ?? "");
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function updatesCsv(rows) {
	const head = "time_utc,record,service,previous_ip,ip,result,detail";
	const lines = rows.map((u) =>
		[
			u.created_at,
			u.hostname === "@" ? u.domainname : `${u.hostname}.${u.domainname}`,
			u.service_name,
			u.old_ip,
			u.new_ip,
			u.ok === 1 ? "ok" : u.ok === 2 ? "skipped" : "failed",
			u.detail,
		]
			.map(csvCell)
			.join(","),
	);
	return `${[head, ...lines].join("\n")}\n`;
}

import logger from "./logger";
import {
	clearHold,
	clearWaitHolds,
	domainHealth,
	failStreak,
	getDomain,
	getDomains,
	getService,
	getServices,
	getState,
	isHeld,
	lastGoodPush,
	logUpdate,
	pruneUpdates,
	recentIpChanges,
	recordIpChange,
	saveResolution,
	setHold,
	setState,
} from "./db";
import { CATALOG } from "./services/catalog";
import { checkRecord } from "./services/dnstools";
import { getPublicIp, getPublicIp6 } from "./services/ipcheck";
import { notify } from "./services/notify";
import { updateRecord } from "./services/providers";

const CHECK_TIMEOUT_MS = 10000;
// pushOnChange providers still re-assert a same-IP record once a day.
const REASSERT_MS = 24 * 60 * 60 * 1000;
// Transient failures back off up to this long between attempts.
const MAX_BACKOFF_SEC = 3600;
// How often the "does it resolve?" check runs without an IP change.
const RESOLVE_EVERY_MS = 10 * 60 * 1000;
// Wait after a push before asking the nameservers, so the provider has published it.
const RESOLVE_AFTER_PUSH_MS = 20 * 1000;
const FAILURE_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // max one failure push per hour

let timer = null;
let inflight = null;
let started = false;
// When each service last ran (ms); a service runs when its own interval is up.
const lastRun = new Map();

// Every run that can call a provider goes through this chain, so a manual
// push never overlaps a cycle (deSEC allows only 2 updates / 2 min).
let chain = Promise.resolve();
function exclusive(fn) {
	const run = chain.then(fn, fn);
	chain = run.catch(() => {});
	return run;
}

// Single-flight: the timer, the startup check and POST /check share one
// in-progress run. Scheduled ticks push only the services that are due;
// Check now (force) pushes every active service.
export function checkOnce({ force = true } = {}) {
	inflight ??= exclusive(() => runCheck({ force })).finally(() => {
		inflight = null;
	});
	return inflight;
}

// Push one service now (after it is added or resumed, or gets a record).
// Fire-and-forget for callers; errors are logged.
export function pushServiceSoon(serviceId) {
	exclusive(() => runCheck({ force: true, only: serviceId })).catch((err) =>
		logger.error(`[SCHED] push for service ${serviceId} failed: ${err.message}`),
	);
}

const fqdnOf = (d) => (d.hostname === "@" ? d.domainname : `${d.hostname}.${d.domainname}`);

async function detect(needV6) {
	const last = getState("last_ip")?.value;
	const v4 = await getPublicIp({ last });
	const changed = last !== v4.ip;
	// The first check on an install that predates ip_changes seeds a baseline row.
	if (changed || recentIpChanges(1).length === 0) recordIpChange(v4.ip, last, v4.source);
	setState("last_ip", v4.ip);
	setState("last_source", v4.source);
	setState("last_check", new Date().toISOString());
	setState("last_check_error", "");

	let v6 = null;
	let v6Error = null;
	const last6 = getState("last_ip6")?.value || null;
	if (needV6) {
		try {
			v6 = (await getPublicIp6({ last: last6 })).ip;
			setState("last_ip6", v6);
		} catch (err) {
			v6Error = err.message;
		}
	}
	return { last, ip: v4.ip, source: v4.source, changed, last6, ip6: v6, changed6: Boolean(v6 && v6 !== last6), v6Error };
}

async function runCheck({ force = false, only = null } = {}) {
	const services = getServices().filter((s) => s.status === "active" && (!only || s.id === only));
	const domainsBy = new Map(services.map((s) => [s.id, getDomains(s.id)]));
	const needV6 = [...domainsBy.values()].some((ds) => ds.some((d) => d.record_type === "AAAA"));

	let now;
	try {
		now = await detect(needV6);
	} catch (err) {
		// No agreed IP: push nothing rather than risk a wrong address.
		setState("last_check_error", err.message);
		maybeNotifyInconclusive(err.message);
		throw err;
	}
	// A new address makes any time-based back-off moot.
	if (now.changed || now.changed6) clearWaitHolds();

	const results = [];
	const startedAt = Date.now();
	for (const service of services) {
		const due =
			force ||
			now.changed ||
			now.changed6 ||
			!lastRun.has(service.id) ||
			startedAt - lastRun.get(service.id) >= service.interval_sec * 1000 - 5000;
		if (!due) continue;
		lastRun.set(service.id, startedAt);
		const onChangeOnly = CATALOG[service.provider]?.pushOnChange;

		// Re-read each record: an IP change may have just cleared its hold.
		for (const listed of domainsBy.get(service.id)) {
			const domain = getDomain(listed.id) ?? listed;
			const v6 = domain.record_type === "AAAA";
			const ip = v6 ? now.ip6 : now.ip;
			const previous = v6 ? now.last6 : now.last;
			if (!ip) {
				const detail = `no IPv6 address detected${now.v6Error ? `: ${now.v6Error}` : ""}`;
				logUpdate(service.id, domain.id, { old_ip: previous, new_ip: "", ok: false, detail });
				results.push({ service: service.name, domain: fqdnOf(domain), ok: false, detail });
				continue;
			}
			if (isHeld(domain)) {
				logUpdate(service.id, domain.id, {
					old_ip: previous,
					new_ip: ip,
					ok: "skipped",
					detail: `held: ${domain.hold_reason ?? "waiting"}`,
				});
				continue;
			}
			// Namecheap returns ErrCount 0 even for a same-IP update (verified live
			// 2026-09-19), so most providers push every due cycle and keep
			// asserting the record. Push-on-change providers (FreeDNS, dyndns2)
			// treat repeated same-IP updates as abuse, so they skip until the IP
			// changes or a day has passed.
			if (onChangeOnly && isCurrent(domain.id, ip)) {
				logUpdate(service.id, domain.id, {
					old_ip: previous,
					new_ip: ip,
					ok: "skipped",
					detail: "unchanged; push-on-change provider",
				});
				continue;
			}
			results.push(await pushOne(service, domain, ip, previous));
		}
	}

	maybeNotify({ changed: now.changed, ip: now.ip, source: now.source, results }, now.last);
	scheduleResolution(now.changed || now.changed6 || results.length > 0 ? RESOLVE_AFTER_PUSH_MS : null);
	return { changed: now.changed, ip: now.ip, ip6: now.ip6, source: now.source, results };
}

async function pushOne(service, domain, ip, previous) {
	let res;
	try {
		res = await updateRecord(service, domain, ip, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
	} catch (err) {
		res = { ok: false, detail: err.message };
	}
	logUpdate(service.id, domain.id, { old_ip: previous, new_ip: ip, ok: res.ok, detail: res.detail });
	applyHold(service, domain, res);
	return { service: service.name, domain: fqdnOf(domain), ...res };
}

// After a failure, decide when to try again:
//   hard        hold until the user edits the record or presses Retry
//   retryAfter  wait as long as the provider asked
//   otherwise   from the third failure in a row, back off exponentially
function applyHold(service, domain, res) {
	if (res.ok) {
		if (domain.hold_kind) clearHold(domain.id);
		return;
	}
	if (res.hard) {
		setHold(domain.id, { kind: "hard", reason: res.detail });
		notify(
			"DNS record needs attention",
			`${fqdnOf(domain)} (${service.name}): ${res.detail}. Updates for it are paused until you fix it and press Retry.`,
			{ tags: "warning", priority: "high", event: "needs-attention" },
		);
		return;
	}
	if (res.retryAfter) {
		setHold(domain.id, { kind: "wait", seconds: Math.round(res.retryAfter), reason: res.detail });
		return;
	}
	const n = failStreak(domain.id);
	if (n >= 3) {
		const seconds = Math.min(service.interval_sec * 2 ** (n - 2), MAX_BACKOFF_SEC);
		setHold(domain.id, { kind: "wait", seconds, reason: `backing off after ${n} failures in a row` });
	}
}

// True when the record's last good push already set this IP within a day.
function isCurrent(domainId, ip) {
	const last = lastGoodPush(domainId);
	if (!last || last.new_ip !== ip) return false;
	return Date.now() - Date.parse(`${last.created_at.replace(" ", "T")}Z`) < REASSERT_MS;
}

// "Push now" / "Retry" for one record: ignores holds and push-on-change, uses
// the last detected IP, and returns the provider's reply.
export function pushDomainNow(domainId) {
	return exclusive(async () => {
		const domain = getDomain(domainId);
		if (!domain) return { ok: false, detail: "record not found" };
		const service = getService(domain.service_id);
		const v6 = domain.record_type === "AAAA";
		let ip = getState(v6 ? "last_ip6" : "last_ip")?.value;
		if (!ip) ip = v6 ? (await getPublicIp6({})).ip : (await getPublicIp({})).ip;
		const res = await pushOne(service, domain, ip, ip);
		scheduleResolution(RESOLVE_AFTER_PUSH_MS);
		return res;
	});
}

// ---------- notifications ----------

let lastNotifiedFailed = null;
let lastInconclusive = null;

function maybeNotify(result, lastIp) {
	if (result.changed) {
		notify(
			"IP changed",
			`Public IP changed ${lastIp ?? "?"} → ${result.ip} (${result.source}). ${result.results
				.map((r) => `${r.domain}: ${r.ok ? "OK" : `FAIL ${(r.detail ?? "").slice(0, 80)}`}`)
				.join(" | ")}`,
			{ tags: "globe", priority: "high", event: "ip-changed" },
		);
	}
	const failed = result.results.filter((r) => !r.ok);
	if (failed.length > 0) {
		// A persistent outage shouldn't push every 5 minutes forever.
		if (!lastNotifiedFailed || Date.now() - lastNotifiedFailed > FAILURE_NOTIFY_COOLDOWN_MS) {
			notify("DNS update failed", `Failed: ${failed.map((f) => f.domain).join(", ")}. Check the dashboard.`, {
				tags: "warning",
				priority: "high",
				event: "update-failed",
			});
			lastNotifiedFailed = Date.now();
		}
	} else if (lastNotifiedFailed && result.results.length > 0) {
		notify("DNS updates recovered", `All ${result.results.length} pushes in the last cycle succeeded.`, {
			tags: "white_check_mark",
			event: "recovered",
		});
		lastNotifiedFailed = null;
	}
}

function maybeNotifyInconclusive(message) {
	if (lastInconclusive && Date.now() - lastInconclusive < FAILURE_NOTIFY_COOLDOWN_MS) return;
	lastInconclusive = Date.now();
	notify("Public IP check inconclusive", `${message}. No records were updated this cycle.`, {
		tags: "warning",
		event: "ip-inconclusive",
	});
}

// ---------- resolution checks ----------

let resolveTimer = null;
let lastResolve = 0;
let resolving = false;

// Run after delayMs or, with null, only if the regular interval has passed.
// EZDYNDNS_RESOLVE_CHECKS=0 turns the checks off (no outbound DNS, or tests).
function scheduleResolution(delayMs) {
	if (process.env.EZDYNDNS_RESOLVE_CHECKS === "0") return;
	if (delayMs == null && Date.now() - lastResolve < RESOLVE_EVERY_MS) return;
	if (resolveTimer) clearTimeout(resolveTimer);
	resolveTimer = setTimeout(() => {
		resolveTimer = null;
		refreshResolutions().catch((err) => logger.warn(`[DNS] resolution check failed: ${err.message}`));
	}, delayMs ?? 0);
	resolveTimer.unref?.();
}

export async function refreshResolutions() {
	if (resolving) return;
	resolving = true;
	lastResolve = Date.now();
	try {
		for (const d of domainHealth(1)) {
			if (d.service_status !== "active") continue;
			const expected = lastGoodPush(d.id)?.new_ip ?? null;
			const { verdict, result } = await checkRecord(fqdnOf(d), d.record_type ?? "A", expected);
			saveResolution(d.id, {
				expected,
				verdict,
				results: [
					...result.authoritative.map((r) => ({ ...r, kind: "authoritative" })),
					...result.public.map((r) => ({ ...r, kind: "public" })),
				],
			});
		}
	} finally {
		resolving = false;
	}
}

// ---------- timer ----------

function nextIntervalMs() {
	const active = getServices().filter((s) => s.status === "active");
	if (active.length === 0) return null;
	return Math.min(...active.map((s) => s.interval_sec)) * 1000;
}

const tickLabel = () => {
	const ms = nextIntervalMs();
	return ms ? `${ms / 1000}s` : "none (no active services)";
};

function scheduleNext() {
	if (timer) clearTimeout(timer);
	const intervalMs = nextIntervalMs();
	// The dashboard's "next check" countdown reads this.
	setState("next_check", intervalMs ? new Date(Date.now() + intervalMs).toISOString() : "");
	if (!intervalMs) return;

	// One loop ticking at the shortest active interval; each tick checks the IP
	// and pushes the services whose own interval is up (all of them on a change).
	timer = setTimeout(async () => {
		try {
			await checkOnce({ force: false });
		} catch (err) {
			logger.error(`[SCHED] check failed: ${err.message}`);
		} finally {
			scheduleNext();
		}
	}, intervalMs);
}

// Watchdog: if the check loop silently stops (timer bug, hung fetch), the
// process is still alive and /health would look fine to a container check that
// only tests HTTP. Push once per hour when checks go stale.
function startWatchdog() {
	setInterval(() => {
		const lastCheck = getState("last_check")?.value;
		if (!lastCheck) return; // never checked yet; startup check handles it
		const ageMs = Date.now() - new Date(lastCheck).getTime();
		const intervalSec = Math.min(...getServices().map((s) => s.interval_sec).concat(600));
		const thresholdMs = Math.max(3 * intervalSec * 1000, 10 * 60 * 1000);
		if (ageMs < thresholdMs) return;
		if (lastWatchdogFired && Date.now() - lastWatchdogFired < 60 * 60 * 1000) return;
		lastWatchdogFired = Date.now();
		notify(
			"ezdyndns check loop stalled",
			`No successful check for ${Math.round(ageMs / 60000)} min (expected every ${Math.round(intervalSec / 60)} min). The updater may not be running.`,
			{ tags: "warning", priority: "high", event: "stalled" },
		);
		logger.error(`[SCHED] watchdog: last check ${Math.round(ageMs / 1000)}s ago`);
	}, 60 * 1000).unref?.();
}

let lastWatchdogFired = null;

export function startScheduler() {
	if (started) return restartScheduler();
	started = true;
	scheduleNext();
	checkOnce().catch((err) => {
		logger.error(`[SCHED] initial check failed: ${err.message}`);
		notify("ezdyndns initial check failed", err.message.slice(0, 200), {
			tags: "warning",
			priority: "high",
			event: "stalled",
		});
	});
	// Daily log prune (retention in db.js RETENTION).
	pruneUpdates();
	setInterval(pruneUpdates, 24 * 60 * 60 * 1000).unref?.();
	startWatchdog();
	logger.info(`[SCHED] scheduler started; tick ${tickLabel()}`);
}

export function stopScheduler() {
	if (timer) clearTimeout(timer);
	timer = null;
	logger.info("[SCHED] scheduler stopped");
}

// Re-derive the timer after a service change. Does NOT run a check (callers
// that need one use pushServiceSoon) or re-register the prune/watchdog.
export function restartScheduler() {
	scheduleNext();
	logger.info(`[SCHED] rescheduled; tick ${tickLabel()}`);
}

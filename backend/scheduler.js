import logger from "./logger";
import { getDomains, getServices, getState, logUpdate, setState, pruneUpdates } from "./db";
import { getPublicIp } from "./services/ipcheck";
import { updateRecord } from "./services/providers";
import { notify } from "./services/notify";

const CHECK_TIMEOUT_MS = 10000;
let timer = null;
let running = false;

export async function checkOnce() {
	const current = await getPublicIp();
	const last = getState("last_ip")?.value;
	const changed = last !== current.ip;

	setState("last_ip", current.ip);
	setState("last_check", new Date().toISOString());
	const results = [];

	for (const service of getServices()) {
		if (service.status !== "active") continue;
		for (const domain of getDomains(service.id)) {
			// Namecheap returns ErrCount 0 / Done true even for a same-IP update
			// (verified live 2026-09-19), so we push EVERY cycle. Each interval
			// produces a logged success/failure row; a DDNS daemon should keep
			// trying until it succeeds. Cloudflare's API limit (1200/5min) is
			// nowhere near this cadence.
			try {
				const res = await updateRecord(service, domain, current.ip, {
					signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
				});
				logUpdate(service.id, domain.id, {
					old_ip: last,
					new_ip: current.ip,
					ok: res.ok,
					detail: res.detail,
				});
				results.push({
					service: service.name,
					domain: `${domain.hostname}.${domain.domainname}`,
					...res,
				});
			} catch (err) {
				logUpdate(service.id, domain.id, {
					old_ip: last,
					new_ip: current.ip,
					ok: false,
					detail: err.message,
				});
				results.push({
					service: service.name,
					domain: `${domain.hostname}.${domain.domainname}`,
					ok: false,
					detail: err.message,
				});
			}
		}
	}

	maybeNotify({ changed, ip: current.ip, source: current.source, results }, last);
	return { changed, ip: current.ip, source: current.source, results };
}

// Push notification on IP change and on any failed cycle.
function maybeNotify(result, lastIp) {
	if (result.changed) {
		notify(
			"IP changed",
			`Public IP changed ${lastIp ?? "?"} → ${result.ip} (${result.source}). ` +
				result.results.map((r) => `${r.domain}: ${r.ok ? "OK" : "FAIL " + (r.detail ?? "").slice(0, 80)}`).join(" | "),
			{ tags: "globe", priority: "high" },
		);
	}
	const failed = result.results.filter((r) => !r.ok);
	if (failed.length > 0) {
		// Only notify on failure when it's a NEW failure (previous cycle ok) —
		// a persistent outage shouldn't push every 5 minutes forever.
		const recovered = failed.map((f) => f.domain).join(", ");
		if (!lastNotifiedFailed || Date.now() - lastNotifiedFailed > FAILURE_NOTIFY_COOLDOWN_MS) {
			notify(
				"DNS update failed",
				`Failed: ${recovered}. Check the dashboard.`,
				{ tags: "warning", priority: "high" },
			);
			lastNotifiedFailed = Date.now();
		}
	} else {
		lastNotifiedFailed = null;
	}
}

let lastNotifiedFailed = null;
const FAILURE_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // max one failure push per hour

function nextIntervalMs() {
	const active = getServices().filter((s) => s.status === "active");
	if (active.length === 0) return null;
	return Math.min(...active.map((s) => s.interval_sec)) * 1000;
}

function scheduleNext() {
	if (timer) clearTimeout(timer);
	const intervalMs = nextIntervalMs();
	if (!intervalMs) return;

	// One serialized loop. The shortest active interval controls the IP-check
	// cadence; provider calls remain conditional on a changed/unreconciled IP.
	timer = setTimeout(async () => {
		if (running) return scheduleNext();
		running = true;
		try {
			await checkOnce();
		} catch (err) {
			logger.error(`[SCHED] check failed: ${err.message}`);
		} finally {
			running = false;
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
			{ tags: "warning", priority: "high" },
		);
		logger.error(`[SCHED] watchdog: last check ${Math.round(ageMs / 1000)}s ago`);
	}, 60 * 1000).unref?.();
}

let lastWatchdogFired = null;

export function startScheduler() {
	scheduleNext();
	checkOnce().catch((err) => {
		logger.error(`[SCHED] initial check failed: ${err.message}`);
		notify("ezdyndns initial check failed", err.message.slice(0, 200), {
			tags: "warning",
			priority: "high",
		});
	});
	// Daily log prune: successes live 3 days, failures 30.
	pruneUpdates();
	setInterval(pruneUpdates, 24 * 60 * 60 * 1000).unref?.();
	startWatchdog();
	logger.info(`[SCHED] scheduler started; interval ${nextIntervalMs() ?? "none"}ms`);
}

export function stopScheduler() {
	if (timer) clearTimeout(timer);
	timer = null;
	logger.info("[SCHED] scheduler stopped");
}

export function restartScheduler() {
	stopScheduler();
	startScheduler();
}
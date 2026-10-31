import { Database } from "bun:sqlite";

import { encryptSecret } from "./crypto";
import logger from "./logger";

const DB_PATH = process.env.EZDYNDNS_DB || `${import.meta.dir}/../db/ezdyndns.db`;

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
	CREATE TABLE IF NOT EXISTS services (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		provider TEXT NOT NULL CHECK (provider IN ('namecheap', 'cloudflare')),
		username TEXT,
		password TEXT,
		status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
		interval_sec INTEGER NOT NULL DEFAULT 300 CHECK (interval_sec >= 60),
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE TABLE IF NOT EXISTS domains (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
		hostname TEXT NOT NULL,
		domainname TEXT NOT NULL,
		password TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE (service_id, hostname, domainname)
	);
	CREATE TABLE IF NOT EXISTS updates (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
		domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
		old_ip TEXT,
		new_ip TEXT NOT NULL,
		ok INTEGER NOT NULL DEFAULT 0,
		detail TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
	-- What resolvers answer for each record (dashboard "DNS" column); one row per record.
	CREATE TABLE IF NOT EXISTS resolutions (
		domain_id INTEGER PRIMARY KEY,
		expected TEXT,
		verdict TEXT NOT NULL,
		results TEXT NOT NULL,
		checked_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	-- One row per observed public-IP change. Kept apart from updates, which is
	-- pruned after 3 days, so the dashboard can show how long an IP has held.
	CREATE TABLE IF NOT EXISTS ip_changes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ip TEXT NOT NULL,
		previous_ip TEXT,
		source TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
`);

const columns = (table) => db.query(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// Migrations: CREATE TABLE only covers fresh installs, so any change to a CHECK
// constraint needs an explicit table rebuild. SQLite can't ALTER a CHECK, so we
// recreate + copy when the stored DDL no longer matches the expected one.
const MIGRATIONS = [
	{
		// 'dedyn' (deSEC / dedyn.io) provider added 2026-10-02
		id: "0001-provider-dedyn",
		probe: () =>
			db
				.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='services'")
				.get()?.sql?.includes("'dedyn'") ?? false,
		up: () =>
			db.transaction(() => {
				db.exec(`
					CREATE TABLE services_new (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						name TEXT NOT NULL UNIQUE,
						provider TEXT NOT NULL CHECK (provider IN ('namecheap', 'cloudflare', 'dedyn')),
						username TEXT,
						password TEXT,
						status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
						interval_sec INTEGER NOT NULL DEFAULT 300 CHECK (interval_sec >= 60),
						created_at TEXT NOT NULL DEFAULT (datetime('now')),
						updated_at TEXT NOT NULL DEFAULT (datetime('now'))
					);
					INSERT INTO services_new SELECT * FROM services;
					DROP TABLE services;
					ALTER TABLE services_new RENAME TO services;
				`);
			})(),
	},
	{
		// Duck DNS, Porkbun, DigitalOcean, Gandi and FreeDNS added 2026-10-31. The
		// provider list now lives in services/catalog.js and is checked by the API,
		// so the CHECK is dropped instead of rebuilding the table for every provider.
		// foreign_keys is off on this connection, so DROP TABLE leaves domains alone.
		id: "0002-provider-check-in-code",
		probe: () =>
			!(
				db
					.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='services'")
					.get()
					?.sql?.includes("CHECK (provider") ?? true
			),
		up: () =>
			db.transaction(() => {
				db.exec(`
					CREATE TABLE services_new (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						name TEXT NOT NULL UNIQUE,
						provider TEXT NOT NULL,
						username TEXT,
						password TEXT,
						status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
						interval_sec INTEGER NOT NULL DEFAULT 300 CHECK (interval_sec >= 60),
						created_at TEXT NOT NULL DEFAULT (datetime('now')),
						updated_at TEXT NOT NULL DEFAULT (datetime('now'))
					);
					INSERT INTO services_new SELECT * FROM services;
					DROP TABLE services;
					ALTER TABLE services_new RENAME TO services;
				`);
			})(),
	},
	{
		// 2026-10-31: AAAA records, holds after hard failures, provider settings
		// (dyndns2 server) and the resolution cache. domains is rebuilt because its
		// UNIQUE now includes record_type (an A and an AAAA for the same name);
		// ids are copied so updates.domain_id still points at the right row.
		id: "0003-records-holds-settings",
		probe: () => columns("domains").includes("record_type"),
		up: () =>
			db.transaction(() => {
				db.exec(`
					CREATE TABLE domains_new (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
						hostname TEXT NOT NULL,
						domainname TEXT NOT NULL,
						password TEXT,
						record_type TEXT NOT NULL DEFAULT 'A' CHECK (record_type IN ('A', 'AAAA')),
						hold_until TEXT,
						hold_kind TEXT,
						hold_reason TEXT,
						created_at TEXT NOT NULL DEFAULT (datetime('now')),
						updated_at TEXT NOT NULL DEFAULT (datetime('now')),
						UNIQUE (service_id, hostname, domainname, record_type)
					);
					INSERT INTO domains_new (id, service_id, hostname, domainname, password, created_at, updated_at)
						SELECT id, service_id, hostname, domainname, password, created_at, updated_at FROM domains;
					DROP TABLE domains;
					ALTER TABLE domains_new RENAME TO domains;
				`);
				if (!columns("services").includes("options")) db.exec("ALTER TABLE services ADD COLUMN options TEXT");
			})(),
	},
];

db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
const applied = new Set(db.query("SELECT id FROM schema_migrations").all().map((r) => r.id));
for (const m of MIGRATIONS) {
	if (applied.has(m.id)) continue;
	if (m.probe()) {
		db.query("INSERT INTO schema_migrations (id) VALUES (?)").run(m.id);
		continue;
	}
	m.up();
	db.query("INSERT INTO schema_migrations (id) VALUES (?)").run(m.id);
	logger.info(`[DB] migration applied: ${m.id}`);
}

export const getServices = () =>
	db
		.query(
			`SELECT s.*, GROUP_CONCAT(json_object('id', d.id, 'hostname', d.hostname, 'domainname', d.domainname), '||') as domains
			 FROM services s LEFT JOIN domains d ON d.service_id = s.id GROUP BY s.id ORDER BY s.name`,
		)
		.all()
		.map((s) => ({
			...s,
			domains: s.domains
				? s.domains.split("||").map((d) => {
						const parsed = JSON.parse(d);
						return { ...parsed, password: parsed.password ? "********" : null };
					})
				: [],
		}));

export const getService = (id) => db.query("SELECT * FROM services WHERE id = ?").get(id);
export const getDomains = (serviceId) =>
	db.query("SELECT * FROM domains WHERE service_id = ?").all(serviceId);

export const createService = ({ name, provider, username, password, interval_sec, options }) =>
	db
		.query("INSERT INTO services (name, provider, username, password, interval_sec, options) VALUES (?, ?, ?, ?, ?, ?)")
		.run(
			name,
			provider,
			username ? encryptSecret(username) : null,
			password ? encryptSecret(password) : null,
			interval_sec ?? 300,
			options && Object.keys(options).length ? JSON.stringify(options) : null,
		).lastInsertRowid;

// Provider settings (non-secret, e.g. a dyndns2 server) live in services.options.
export const serviceOptions = (service) => {
	try {
		return JSON.parse(service?.options ?? "{}") ?? {};
	} catch {
		return {};
	}
};

export const addDomain = (serviceId, { hostname, domainname, password, record_type }) =>
	db
		.query("INSERT INTO domains (service_id, hostname, domainname, password, record_type) VALUES (?, ?, ?, ?, ?)")
		.run(serviceId, hostname, domainname, password ? encryptSecret(password) : null, record_type === "AAAA" ? "AAAA" : "A")
		.lastInsertRowid;

export const getDomain = (id) => db.query("SELECT * FROM domains WHERE id = ?").get(id);

// Edit a record in place. A new name or type starts a fresh history, so any
// hold is cleared; an empty password keeps the stored one.
export const updateDomain = (serviceId, domainId, { hostname, domainname, record_type, password }) =>
	db
		.query(
			`UPDATE domains SET hostname = ?, domainname = ?, record_type = ?,
			 password = COALESCE(?, password), hold_until = NULL, hold_kind = NULL, hold_reason = NULL,
			 updated_at = datetime('now') WHERE service_id = ? AND id = ?`,
		)
		.run(hostname, domainname, record_type === "AAAA" ? "AAAA" : "A", password ? encryptSecret(password) : null, serviceId, domainId);

// FK enforcement is off on this connection, so ON DELETE CASCADE never fires:
// remove a record's history (and a service's records) explicitly.
export const deleteDomain = (serviceId, domainId) =>
	db.transaction(() => {
		const removed = db.run("DELETE FROM domains WHERE service_id = ? AND id = ?", [serviceId, domainId]);
		if (removed.changes) {
			db.run("DELETE FROM updates WHERE domain_id = ?", [domainId]);
			db.run("DELETE FROM resolutions WHERE domain_id = ?", [domainId]);
		}
	})();

// Holds: "hard" waits for the user (bad credentials, host not on the account);
// "wait" expires on its own (rate limit, back-off). Times are SQLite UTC text.
export const setHold = (domainId, { kind, seconds, reason }) =>
	db
		.query(
			`UPDATE domains SET hold_kind = ?, hold_reason = ?,
			 hold_until = CASE WHEN ? IS NULL THEN '9999-12-31 00:00:00' ELSE datetime('now', '+' || ? || ' seconds') END
			 WHERE id = ?`,
		)
		.run(kind, reason ?? null, seconds ?? null, seconds ?? null, domainId);
export const clearHold = (domainId) =>
	db.run("UPDATE domains SET hold_until = NULL, hold_kind = NULL, hold_reason = NULL WHERE id = ?", [domainId]);
// An IP change makes a time-based back-off moot; hard holds stay.
export const clearWaitHolds = () => db.run("UPDATE domains SET hold_until = NULL, hold_kind = NULL, hold_reason = NULL WHERE hold_kind = 'wait'");
export const isHeld = (domain) => Boolean(domain.hold_until) && domain.hold_until > sqlNow();
const sqlNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// Failed pushes since the last success; skipped cycles (ok = 2) don't count either way.
export const failStreak = (domainId) =>
	db
		.query(
			`SELECT COUNT(*) AS n FROM updates WHERE domain_id = ? AND ok = 0
			 AND id > COALESCE((SELECT MAX(id) FROM updates WHERE domain_id = ? AND ok = 1), 0)`,
		)
		.get(domainId, domainId).n;
// Partial update: only the keys present are written. Credentials are
// re-encrypted; an empty string means "keep the stored value".
export const updateService = (id, { name, username, password, interval_sec, status, options }) => {
	const sets = [];
	const args = [];
	if (options && Object.keys(options).length) {
		sets.push("options = ?");
		args.push(JSON.stringify(options));
	}
	if (name) {
		sets.push("name = ?");
		args.push(name);
	}
	if (interval_sec) {
		sets.push("interval_sec = ?");
		args.push(Number(interval_sec));
	}
	if (status) {
		sets.push("status = ?");
		args.push(status);
	}
	if (username) {
		sets.push("username = ?");
		args.push(encryptSecret(username));
	}
	if (password) {
		sets.push("password = ?");
		args.push(encryptSecret(password));
	}
	if (sets.length === 0) return;
	db.run(`UPDATE services SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...args, id]);
};
export const deleteService = (id) =>
	db.transaction(() => {
		db.run("DELETE FROM resolutions WHERE domain_id IN (SELECT id FROM domains WHERE service_id = ?)", [id]);
		db.run("DELETE FROM updates WHERE service_id = ?", [id]);
		db.run("DELETE FROM domains WHERE service_id = ?", [id]);
		db.run("DELETE FROM services WHERE id = ?", [id]);
	})();
export const setStatus = (id, status) =>
	db.run("UPDATE services SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id]);

// ok: true (1), false (0) or "skipped" (2: a cycle that sent nothing, e.g. a
// held record or a push-on-change provider with the IP already set).
export const logUpdate = (serviceId, domainId, { old_ip, new_ip, ok, detail }) =>
	db
		.query("INSERT INTO updates (service_id, domain_id, old_ip, new_ip, ok, detail) VALUES (?, ?, ?, ?, ?, ?)")
		.run(serviceId, domainId, old_ip ?? null, new_ip ?? "", ok === "skipped" ? 2 : ok ? 1 : 0, detail ?? null);

export const domainIsCurrent = (domainId, ip) =>
	Boolean(
		db
			.query("SELECT 1 FROM updates WHERE domain_id = ? AND new_ip = ? AND ok = 1 ORDER BY id DESC LIMIT 1")
			.get(domainId, ip),
	);

// The newest successful push for one record, for providers that push only on change.
export const lastGoodPush = (domainId) =>
	db
		.query("SELECT new_ip, created_at FROM updates WHERE domain_id = ? AND ok = 1 ORDER BY id DESC LIMIT 1")
		.get(domainId);

export const recentUpdates = (limit = 25, { domainId, failedOnly, sentOnly } = {}) => {
	const where = [];
	const args = [];
	if (domainId) {
		where.push("u.domain_id = ?");
		args.push(Number(domainId));
	}
	if (failedOnly) where.push("u.ok = 0");
	if (sentOnly) where.push("u.ok != 2");
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	return db
		.query(
			`SELECT u.*, d.hostname, d.domainname, s.name as service_name
			 FROM updates u JOIN domains d ON d.id = u.domain_id JOIN services s ON s.id = u.service_id
			 ${clause} ORDER BY u.id DESC LIMIT ?`,
		)
		.all(...args, limit);
};

export const countUpdates = ({ domainId, failedOnly, sentOnly } = {}) => {
	const where = [];
	const args = [];
	if (domainId) {
		where.push("domain_id = ?");
		args.push(Number(domainId));
	}
	if (failedOnly) where.push("ok = 0");
	if (sentOnly) where.push("ok != 2");
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	return db.query(`SELECT COUNT(*) AS n FROM updates ${clause}`).get(...args).n;
};

// Per-record health for the dashboard: the last N pushes (newest first), the
// last success, and how many pushes in a row have failed.
export const domainHealth = (cycles = 24) =>
	db
		.query(
			`SELECT d.id, d.hostname, d.domainname, d.record_type, d.hold_until, d.hold_kind, d.hold_reason,
			        d.service_id, s.name AS service_name, s.provider, s.status AS service_status,
			        r.verdict AS dns_verdict, r.results AS dns_results, r.expected AS dns_expected, r.checked_at AS dns_checked_at
			 FROM domains d JOIN services s ON s.id = d.service_id
			 LEFT JOIN resolutions r ON r.domain_id = d.id
			 ORDER BY s.name, d.domainname, d.hostname`,
		)
		.all()
		.map((d) => {
			const recent = db
				.query("SELECT ok, new_ip, detail, created_at FROM updates WHERE domain_id = ? ORDER BY id DESC LIMIT ?")
				.all(d.id, cycles);
			const lastOk = db
				.query("SELECT new_ip, created_at FROM updates WHERE domain_id = ? AND ok = 1 ORDER BY id DESC LIMIT 1")
				.get(d.id);
			const sent = recent.filter((r) => r.ok !== 2);
			const streak = sent.findIndex((r) => r.ok === 1);
			return {
				...d,
				held: isHeld(d),
				recent,
				last: sent[0] ?? null,
				last_ok: lastOk ?? null,
				fail_streak: streak === -1 ? sent.length : streak,
			};
		});

export const recordIpChange = (ip, previousIp, source) =>
	db.query("INSERT INTO ip_changes (ip, previous_ip, source) VALUES (?, ?, ?)").run(ip, previousIp ?? null, source ?? null);

export const recentIpChanges = (limit = 6) =>
	db.query("SELECT * FROM ip_changes ORDER BY id DESC LIMIT ?").all(limit);

export const getState = (key) => db.query("SELECT value FROM state WHERE key = ?").get(key);

// Prune the update log so per-cycle rows don't grow the DB forever. Defaults:
// successes 3 days, failures 30 (the interesting ones), skipped cycles 1.
export const RETENTION = {
	success: Math.max(1, Number(process.env.EZDYNDNS_KEEP_SUCCESS_DAYS) || 3),
	failure: Math.max(1, Number(process.env.EZDYNDNS_KEEP_FAILURE_DAYS) || 30),
	skipped: 1,
};
export const pruneUpdates = () => {
	db.run(`DELETE FROM updates WHERE ok = 1 AND created_at < datetime('now', '-${RETENTION.success} days')`);
	db.run(`DELETE FROM updates WHERE ok = 0 AND created_at < datetime('now', '-${RETENTION.failure} days')`);
	db.run(`DELETE FROM updates WHERE ok = 2 AND created_at < datetime('now', '-${RETENTION.skipped} days')`);
	db.run("DELETE FROM ip_changes WHERE id NOT IN (SELECT id FROM ip_changes ORDER BY id DESC LIMIT 200)");
};
export const saveResolution = (domainId, { expected, verdict, results }) =>
	db
		.query(
			`INSERT INTO resolutions (domain_id, expected, verdict, results, checked_at) VALUES (?, ?, ?, ?, datetime('now'))
			 ON CONFLICT(domain_id) DO UPDATE SET expected = excluded.expected, verdict = excluded.verdict,
			 results = excluded.results, checked_at = excluded.checked_at`,
		)
		.run(domainId, expected ?? null, verdict, JSON.stringify(results));

// Counts for /api/health: no names, so the unauthenticated endpoint leaks nothing.
export const recordCounts = () => {
	const rows = domainHealth(24).filter((d) => d.service_status === "active");
	return {
		records: rows.length,
		failing: rows.filter((d) => d.last && d.last.ok === 0).length,
		held: rows.filter((d) => d.held).length,
	};
};

export const setState = (key, value) =>
	db
		.query("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.run(key, String(value));

// Never let stored provider credentials serialize to a client response.
export const sanitizeService = (s) =>
	s ? { ...s, username: s.username ? "********" : null, password: s.password ? "********" : null } : null;
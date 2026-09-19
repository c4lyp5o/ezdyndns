import { Database } from "bun:sqlite";

import { encryptSecret } from "./crypto";

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
`);

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

export const createService = ({ name, provider, username, password, interval_sec }) =>
	db
		.query("INSERT INTO services (name, provider, username, password, interval_sec) VALUES (?, ?, ?, ?, ?)")
		.run(
			name,
			provider,
			username ? encryptSecret(username) : null,
			password ? encryptSecret(password) : null,
			interval_sec ?? 300,
		).lastInsertRowid;

export const addDomain = (serviceId, { hostname, domainname, password }) =>
	db
		.query("INSERT INTO domains (service_id, hostname, domainname, password) VALUES (?, ?, ?, ?)")
		.run(serviceId, hostname, domainname, password ? encryptSecret(password) : null)
		.lastInsertRowid;
export const deleteDomain = (serviceId, domainId) =>
	db.run("DELETE FROM domains WHERE service_id = ? AND id = ?", [serviceId, domainId]);
export const deleteService = (id) => db.run("DELETE FROM services WHERE id = ?", [id]);
export const setStatus = (id, status) =>
	db.run("UPDATE services SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id]);

export const logUpdate = (serviceId, domainId, { old_ip, new_ip, ok, detail }) =>
	db
		.query("INSERT INTO updates (service_id, domain_id, old_ip, new_ip, ok, detail) VALUES (?, ?, ?, ?, ?, ?)")
		.run(serviceId, domainId, old_ip ?? null, new_ip, ok ? 1 : 0, detail ?? null);

export const domainIsCurrent = (domainId, ip) =>
	Boolean(
		db
			.query("SELECT 1 FROM updates WHERE domain_id = ? AND new_ip = ? AND ok = 1 ORDER BY id DESC LIMIT 1")
			.get(domainId, ip),
	);

export const recentUpdates = (limit = 25) =>
	db
		.query(
			`SELECT u.*, d.hostname, d.domainname, s.name as service_name
			 FROM updates u JOIN domains d ON d.id = u.domain_id JOIN services s ON s.id = u.service_id
			 ORDER BY u.id DESC LIMIT ?`,
		)
		.all(limit);

export const getState = (key) => db.query("SELECT value FROM state WHERE key = ?").get(key);

// Prune the update log so per-cycle successes don't grow the DB forever:
// keep successes for 3 days, failures for 30 days (they're the interesting ones).
export const pruneUpdates = () => {
	db.run("DELETE FROM updates WHERE ok = 1 AND created_at < datetime('now', '-3 days')");
	db.run("DELETE FROM updates WHERE ok = 0 AND created_at < datetime('now', '-30 days')");
};
export const setState = (key, value) =>
	db
		.query("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.run(key, String(value));

// Never let stored provider credentials serialize to a client response.
export const sanitizeService = (s) =>
	s ? { ...s, username: s.username ? "********" : null, password: s.password ? "********" : null } : null;
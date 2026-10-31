import pkg from "../../package.json";
import { decryptSecret } from "../crypto";
import logger from "../logger";

// The dyndns2 protocol (Dyn's remote access API), used by No-IP and many other
// services: GET <server>/nic/update?hostname=<fqdn>&myip=<ip> with Basic auth.
// Replies start with a code. Dyn and No-IP both say a client must stop after an
// error code until the user fixes it, wait 30 minutes after 911/dnserr, and not
// send repeated nochg updates; the catalog marks these providers pushOnChange.
const NOIP = "https://dynupdate.no-ip.com/nic/update";
const CONTACT = process.env.EZDYNDNS_CONTACT || "https://github.com/c4lyp5o/ezdyndns";
// No-IP wants "Company Program/Version maintainer-contact".
const USER_AGENT = `ezdyndns ezdyndns/${pkg.version} ${CONTACT}`;

const HARD = {
	badauth: "username or password rejected",
	"!donator": "feature not available on this account",
	nohost: "hostname is not on this account",
	notfqdn: "hostname is not a fully qualified domain name",
	numhost: "too many or ambiguous hosts",
	abuse: "hostname blocked for abuse",
	badagent: "client rejected by the server",
};
const LATER = { 911: "server error", dnserr: "server DNS error" };

// The configured server as a full update URL: a bare host gets https:// and /nic/update.
export function updateUrl(server) {
	const raw = String(server ?? "").trim();
	if (!raw) return null;
	try {
		const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		if (u.pathname === "/" || u.pathname === "") u.pathname = "/nic/update";
		return u.toString();
	} catch {
		return null;
	}
}

// Pure reading of a reply line, exported for tests.
export function readReply(line) {
	const code = String(line ?? "").trim().split(/\s+/)[0] ?? "";
	if (code === "good") return { ok: true, detail: line.trim() };
	if (code === "nochg") return { ok: true, detail: "nochg" };
	if (HARD[code]) return { ok: false, hard: true, detail: `${code}: ${HARD[code]}` };
	if (LATER[code]) return { ok: false, retryAfter: 1800, detail: `${code}: ${LATER[code]}; retrying in 30 min` };
	return { ok: false, detail: `unexpected reply: ${String(line).slice(0, 120)}` };
}

async function send(endpoint, user, pass, fqdn, type, ip, signal) {
	const u = new URL(endpoint);
	u.searchParams.set("hostname", fqdn);
	if (ip) u.searchParams.set(type === "AAAA" ? "myipv6" : "myip", ip);
	const res = await fetch(u, {
		signal,
		headers: {
			Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
			"User-Agent": USER_AGENT,
		},
	});
	const body = (await res.text()).trim();
	if (res.status >= 500) return { ok: false, retryAfter: 1800, detail: `HTTP ${res.status}; retrying in 30 min` };
	if (res.status === 401) return { ok: false, hard: true, detail: "badauth: username or password rejected" };
	return readReply(body.split("\n")[0]);
}

const fqdnOf = (d) => (d.hostname === "@" ? d.domainname : `${d.hostname}.${d.domainname}`);

export function endpointFor(provider, options) {
	return provider === "noip" ? NOIP : updateUrl(options?.server);
}

export async function verifyDyndns2(provider, { username, password, hostname, domainname, options, signal } = {}) {
	if (!username || !password) return { ok: false, detail: "needs a username and a password" };
	const endpoint = endpointFor(provider, options);
	if (!endpoint) return { ok: false, detail: "set the update server, e.g. members.dyndns.org" };
	if (!hostname || !domainname) return { ok: false, detail: "add a record to verify against" };
	// No read-only check exists; one update to the connection IP proves it.
	try {
		const r = await send(endpoint, username, password, fqdnOf({ hostname, domainname }), "A", null, signal);
		return r.ok ? { ok: true, detail: `credentials accepted (${r.detail})` } : r;
	} catch (err) {
		return { ok: false, detail: `${new URL(endpoint).host} unreachable: ${err?.name ?? "error"}` };
	}
}

export async function updateDyndns2(service, domain, ip, { signal, options } = {}) {
	const user = decryptSecret(service.username);
	const pass = decryptSecret(service.password);
	if (!user || !pass) return { ok: false, hard: true, detail: "missing username or password" };
	const endpoint = endpointFor(service.provider, options);
	if (!endpoint) return { ok: false, hard: true, detail: "no update server configured" };
	const fqdn = fqdnOf(domain);
	const r = await send(endpoint, user, pass, fqdn, domain.record_type, ip, signal);
	if (!r.ok) logger.warn(`[PROVIDER] ${service.provider} ${fqdn}: ${r.detail}`);
	return r;
}

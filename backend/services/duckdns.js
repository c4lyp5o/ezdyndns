import { decryptSecret } from "../crypto";
import logger from "../logger";

// Duck DNS (https://www.duckdns.org/spec.jsp). The update API only takes the
// token as a query parameter, so the URL is built here and never logged.
// Records are stored as host <subname>, domain duckdns.org; `domains` takes
// just the subname.
export function duckSubname({ hostname, domainname }) {
	const host = String(hostname ?? "").trim().toLowerCase();
	const zone = String(domainname ?? "").trim().toLowerCase();
	if (zone === "duckdns.org" && /^[a-z0-9-]+$/.test(host)) return host;
	// Also accept the whole name typed into the domain field.
	const m = zone.match(/^([a-z0-9-]+)\.duckdns\.org$/);
	if (m && (!host || host === "@")) return m[1];
	return null;
}

async function call(token, subname, ip, signal, type = "A") {
	const u = new URL("https://www.duckdns.org/update");
	u.searchParams.set("domains", subname);
	u.searchParams.set("token", token);
	if (ip) u.searchParams.set(type === "AAAA" ? "ipv6" : "ip", ip);
	u.searchParams.set("verbose", "true");
	const res = await fetch(u, { signal, headers: { "User-Agent": "ezdyndns" } });
	const lines = (await res.text()).trim().split("\n");
	return { res, lines };
}

const notOurs = (sub) => `token rejected or ${sub}.duckdns.org is not on this account (Duck DNS KO)`;

// Duck DNS has no read-only token check: the probe is one real update to the
// connection IP, which is this server's public IP.
export async function verifyDuckdnsToken(token, { hostname, domainname, signal } = {}) {
	if (!token) return { ok: false, detail: "Duck DNS needs a token" };
	const sub = duckSubname({ hostname, domainname });
	if (!sub) return { ok: false, detail: "Duck DNS records are <subname>.duckdns.org; add one to verify the token" };
	try {
		const { res, lines } = await call(token, sub, null, signal);
		if (res.ok && lines[0] === "OK") return { ok: true, detail: `valid Duck DNS token; ${sub}.duckdns.org points at this server` };
		return { ok: false, detail: notOurs(sub) };
	} catch (err) {
		return { ok: false, detail: `duckdns.org unreachable: ${err?.name ?? "error"}` };
	}
}

export async function updateDuckdns(service, domain, ip, { signal } = {}) {
	const token = decryptSecret(service.username);
	if (!token) return { ok: false, detail: "missing Duck DNS token" };
	const sub = duckSubname(domain);
	if (!sub) return { ok: false, detail: "not a <subname>.duckdns.org record" };
	const { res, lines } = await call(token, sub, ip, signal, domain.record_type);
	if (res.ok && lines[0] === "OK") {
		// verbose body: OK / ipv4 / ipv6 / UPDATED|NOCHANGE
		return { ok: true, detail: lines[3] === "NOCHANGE" ? "nochg" : `updated ${sub}.duckdns.org` };
	}
	const detail = res.ok ? notOurs(sub) : `HTTP ${res.status}`;
	logger.warn(`[PROVIDER] duckdns ${sub}: ${detail}`);
	// KO is a wrong token or a subname not on the account: retrying won't help.
	return res.ok ? { ok: false, detail, hard: true } : { ok: false, detail, retryAfter: 600 };
}

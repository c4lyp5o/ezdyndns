import { decryptSecret } from "../crypto";
import logger from "../logger";

// Gandi LiveDNS v5 (https://api.gandi.net/docs/livedns/) with a personal access
// token. PUT on one rrset replaces it whole, so the write is idempotent; the
// read first only avoids a needless write. 300 s is LiveDNS's minimum TTL.
const API = "https://api.gandi.net/v5/livedns";
const TTL = 300;

const auth = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const rrset = (d) =>
	`/domains/${encodeURIComponent(d.domainname)}/records/${encodeURIComponent(d.hostname || "@")}/A`;
const fqdnOf = (d) => (d.hostname === "@" ? d.domainname : `${d.hostname}.${d.domainname}`);

async function call(path, token, { method = "GET", body, signal } = {}) {
	const res = await fetch(`${API}${path}`, { method, headers: auth(token), body: body && JSON.stringify(body), signal });
	const j = await res.json().catch(() => ({}));
	return { res, j };
}

const why = ({ res, j }) => {
	if (res.status === 401) return "token rejected (Gandi 401)";
	if (res.status === 403) return "token expired or lacks Manage domain name technical configurations (Gandi 403)";
	return `HTTP ${res.status}: ${String(j.message ?? j.cause ?? "").slice(0, 160)}`;
};

export async function verifyGandiToken(token, { domainname, signal } = {}) {
	if (!token) return { ok: false, detail: "Gandi needs a personal access token" };
	try {
		const list = await call(domainname ? `/domains/${encodeURIComponent(domainname)}` : "/domains", token, { signal });
		if (list.res.status === 404) return { ok: false, detail: `${domainname} is not on LiveDNS for this token` };
		if (!list.res.ok) return { ok: false, detail: why(list) };
		return { ok: true, detail: domainname ? `valid Gandi token; ${domainname} on LiveDNS` : "valid Gandi token" };
	} catch (err) {
		return { ok: false, detail: `gandi unreachable: ${err?.name ?? "error"}` };
	}
}

export async function updateGandi(service, domain, ip, { signal } = {}) {
	const token = decryptSecret(service.username);
	if (!token) return { ok: false, detail: "missing Gandi token" };
	const fqdn = fqdnOf(domain);

	const current = await call(rrset(domain), token, { signal });
	if (current.res.ok) {
		const values = current.j.rrset_values ?? [];
		if (values.length === 1 && values[0] === ip) return { ok: true, detail: "nochg" };
	} else if (current.res.status !== 404) {
		return fail(fqdn, why(current));
	}

	const write = await call(rrset(domain), token, {
		method: "PUT",
		body: { rrset_values: [ip], rrset_ttl: TTL },
		signal,
	});
	if (!write.res.ok) return fail(fqdn, why(write));
	return { ok: true, detail: `${current.res.ok ? "updated" : "created"} A ${fqdn} -> ${ip}` };
}

function fail(fqdn, detail) {
	logger.warn(`[PROVIDER] gandi ${fqdn}: ${detail}`);
	return { ok: false, detail };
}

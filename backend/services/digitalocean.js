import { decryptSecret } from "../crypto";
import logger from "../logger";

// DigitalOcean domain records (https://docs.digitalocean.com/reference/api/).
// The records list filters on the full record name; create takes the subname
// ("@" for the apex).
const API = "https://api.digitalocean.com/v2";
const TTL = 60;

const auth = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const fqdnOf = (d) => (d.hostname === "@" ? d.domainname : `${d.hostname}.${d.domainname}`);

async function call(path, token, { method = "GET", body, signal } = {}) {
	const res = await fetch(`${API}${path}`, { method, headers: auth(token), body: body && JSON.stringify(body), signal });
	const j = await res.json().catch(() => ({}));
	return { res, j };
}

const why = ({ res, j }) => {
	if (res.status === 401) return "token rejected (DigitalOcean 401)";
	if (res.status === 403) return "token lacks domain scopes (DigitalOcean 403)";
	if (res.status === 429) return "DigitalOcean rate limit; next cycle will retry";
	return `HTTP ${res.status}: ${String(j.message ?? "").slice(0, 160)}`;
};

export async function verifyDigitalOceanToken(token, { domainname, signal } = {}) {
	if (!token) return { ok: false, detail: "DigitalOcean needs an API token" };
	try {
		const account = await call("/account", token, { signal });
		if (!account.res.ok) return { ok: false, detail: why(account) };
		if (!domainname) return { ok: true, detail: "valid DigitalOcean token" };
		const zone = await call(`/domains/${encodeURIComponent(domainname)}`, token, { signal });
		if (zone.res.status === 404) return { ok: false, detail: `${domainname} is not a domain in this DigitalOcean account` };
		if (!zone.res.ok) return { ok: false, detail: why(zone) };
		return { ok: true, detail: `valid DigitalOcean token; ${domainname} found` };
	} catch (err) {
		return { ok: false, detail: `digitalocean unreachable: ${err?.name ?? "error"}` };
	}
}

export async function updateDigitalOcean(service, domain, ip, { signal } = {}) {
	const token = decryptSecret(service.username);
	if (!token) return { ok: false, detail: "missing DigitalOcean token" };
	const zone = encodeURIComponent(domain.domainname);
	const fqdn = fqdnOf(domain);

	const list = await call(`/domains/${zone}/records?type=A&name=${encodeURIComponent(fqdn)}`, token, { signal });
	if (!list.res.ok) return fail(fqdn, why(list));
	const record = list.j.domain_records?.[0];
	if (record?.data === ip) return { ok: true, detail: "nochg" };

	const write = record
		? await call(`/domains/${zone}/records/${record.id}`, token, { method: "PATCH", body: { type: "A", data: ip }, signal })
		: await call(`/domains/${zone}/records`, token, {
				method: "POST",
				body: { type: "A", name: domain.hostname || "@", data: ip, ttl: TTL },
				signal,
			});
	if (!write.res.ok) return fail(fqdn, why(write));
	return { ok: true, detail: `${record ? "updated" : "created"} A ${fqdn} -> ${ip}` };
}

function fail(fqdn, detail) {
	logger.warn(`[PROVIDER] digitalocean ${fqdn}: ${detail}`);
	return { ok: false, detail };
}

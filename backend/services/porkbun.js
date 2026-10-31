import { decryptSecret } from "../crypto";
import logger from "../logger";

// Porkbun API v3 (https://porkbun.com/api/json/v3/documentation). Keys go in
// the X-API-Key / X-Secret-API-Key headers. Every domain must also be opted in
// to API access, which /ping cannot see, so verification reads the record too.
const API = "https://api.porkbun.com/api/json/v3";

const headers = (apiKey, secret) => ({
	"Content-Type": "application/json",
	"X-API-Key": apiKey,
	"X-Secret-API-Key": secret,
});

// Porkbun takes the subdomain alone; empty for the apex.
const sub = (hostname) => (!hostname || hostname === "@" ? "" : hostname);
const byNameType = (action, { hostname, domainname }) =>
	`${API}/dns/${action}/${encodeURIComponent(domainname)}/A${sub(hostname) ? `/${encodeURIComponent(sub(hostname))}` : ""}`;

async function post(url, keys, body, signal) {
	const res = await fetch(url, { method: "POST", headers: keys, body: JSON.stringify(body ?? {}), signal });
	const j = await res.json().catch(() => ({}));
	return { res, j };
}

const why = (j, res) => {
	if (j.code === "API_ACCESS_DISABLED") return "API access is off for this domain (Porkbun → Domain Management → API Access)";
	if (res.status === 429) return "Porkbun rate limit; next cycle will retry";
	return `${j.code ?? `HTTP ${res.status}`}: ${String(j.message ?? "").slice(0, 160)}`;
};

export async function verifyPorkbunKeys(apiKey, secret, { hostname, domainname, signal } = {}) {
	if (!apiKey || !secret) return { ok: false, detail: "Porkbun needs the API key and the secret API key" };
	const keys = headers(apiKey, secret);
	try {
		const ping = await post(`${API}/ping`, keys, {}, signal);
		if (ping.j.status !== "SUCCESS" || ping.j.credentialsValid === false)
			return { ok: false, detail: `keys rejected (${why(ping.j, ping.res)})` };
		if (!domainname) return { ok: true, detail: "valid Porkbun keys" };
		const rec = await post(byNameType("retrieveByNameType", { hostname, domainname }), keys, {}, signal);
		if (rec.j.status !== "SUCCESS") return { ok: false, detail: why(rec.j, rec.res) };
		return { ok: true, detail: `valid Porkbun keys; API access on for ${domainname}` };
	} catch (err) {
		return { ok: false, detail: `porkbun unreachable: ${err?.name ?? "error"}` };
	}
}

export async function updatePorkbun(service, domain, ip, { signal } = {}) {
	const apiKey = decryptSecret(service.username);
	const secret = decryptSecret(service.password);
	if (!apiKey || !secret) return { ok: false, detail: "missing Porkbun keys" };
	const keys = headers(apiKey, secret);
	const fqdn = domain.hostname === "@" ? domain.domainname : `${domain.hostname}.${domain.domainname}`;

	const found = await post(byNameType("retrieveByNameType", domain), keys, {}, signal);
	if (found.j.status !== "SUCCESS") return fail(fqdn, why(found.j, found.res));
	const records = found.j.records ?? [];
	if (records.length > 0 && records.every((r) => r.content === ip)) return { ok: true, detail: "nochg" };

	// editByNameType sets every matching A record; create when there is none.
	// TTL is left out so Porkbun applies the account minimum.
	const write =
		records.length > 0
			? await post(byNameType("editByNameType", domain), keys, { content: ip }, signal)
			: await post(`${API}/dns/create/${encodeURIComponent(domain.domainname)}`, keys, { name: sub(domain.hostname), type: "A", content: ip }, signal);
	if (write.j.status !== "SUCCESS") return fail(fqdn, why(write.j, write.res));
	return { ok: true, detail: `${records.length > 0 ? "updated" : "created"} A ${fqdn} -> ${ip}` };
}

function fail(fqdn, detail) {
	logger.warn(`[PROVIDER] porkbun ${fqdn}: ${detail}`);
	return { ok: false, detail };
}

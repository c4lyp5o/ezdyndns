import { decryptSecret } from "../crypto";
import logger from "../logger";
import { updateAfraid, verifyAfraidToken } from "./afraid";
import { CATALOG, PROVIDERS } from "./catalog";
import { dedynScope, updateDedyn, verifyDedynToken } from "./dedyn";
import { updateDigitalOcean, verifyDigitalOceanToken } from "./digitalocean";
import { updateDuckdns, verifyDuckdnsToken } from "./duckdns";
import { updateDyndns2, verifyDyndns2 } from "./dyndns2";
import { updateGandi, verifyGandiToken } from "./gandi";
import { updatePorkbun, verifyPorkbunKeys } from "./porkbun";

// Provider adapters. Each returns { ok, detail } plus, on failure, either
// hard: true (the request can't succeed until the user fixes something; the
// scheduler holds the record) or retryAfter: seconds (rate limit / server
// trouble; the record waits). domain.record_type is "A" or "AAAA".
// Credentials go in headers / POST body — NEVER in the URL (the 2024 cdyndns bug);
// Namecheap, Duck DNS and FreeDNS only accept them in the URL, so those URLs are never logged.

// Retry-After in seconds, or the fallback when absent or unparseable.
export const retryAfter = (res, fallback = 120) => {
	const v = Number(res.headers.get("retry-after"));
	return Number.isFinite(v) && v > 0 ? Math.min(v, 6 * 3600) : fallback;
};

async function updateNamecheap(service, domain, ip, { signal } = {}) {
	// Namecheap DDNS: https://dynamicdns.park-your-domain.com/update?host=&domain=&password=&ip=
	// IMPORTANT: use encodeURIComponent, NOT URLSearchParams. Namecheap does not
	// URL-decode the password param (verified vs ddclient's raw concatenation),
	// and searchParams.set() form-encodes ' as %27, which Namecheap rejects.
	const q = (v) => encodeURIComponent(v ?? "");
	const url =
		`https://dynamicdns.park-your-domain.com/update?host=${q(domain.hostname)}` +
		`&domain=${q(domain.domainname)}` +
		`&password=${q(decryptSecret(domain.password ?? service.password) ?? "")}` +
		`&ip=${q(ip)}`;

	const res = await fetch(url, { signal, headers: { "User-Agent": "ezdyndns/0.1" } });
	const body = await res.text();
	// Namecheap returns XML; success contains "<ErrCount>0</ErrCount>"
	const ok = res.ok && body.includes("<ErrCount>0</ErrCount>");
	if (!ok) logger.warn(`[PROVIDER] namecheap response: ${body.slice(0, 200)}`);
	if (ok) return { ok, detail: `updated ${domain.hostname}.${domain.domainname}` };
	const err = body.match(/<Err1>([^<]*)<\/Err1>/)?.[1];
	// A wrong password or a host the account doesn't have won't fix itself.
	const hard = /password|not found|domain name not active/i.test(err ?? "");
	return { ok, detail: err ?? body.slice(0, 300), hard, ...(res.status >= 500 ? { retryAfter: 600 } : {}) };
}

async function updateCloudflare(service, domain, ip, { signal } = {}) {
	// Cloudflare DDNS via API v4: find the A record, PATCH it.
	// service.username = API token, service.password unused.
	// Zone is derived from the domain name.
	const headers = {
		Authorization: `Bearer ${decryptSecret(service.username)}`,
		"Content-Type": "application/json",
	};

	const type = domain.record_type === "AAAA" ? "AAAA" : "A";
	const zoneRes = await fetch(
		`https://api.cloudflare.com/client/v4/zones?name=${domain.domainname}`,
		{ signal, headers },
	);
	if (zoneRes.status === 429) return { ok: false, detail: "Cloudflare rate limit", retryAfter: retryAfter(zoneRes, 300) };
	if (zoneRes.status === 401 || zoneRes.status === 403)
		return { ok: false, detail: `token rejected (Cloudflare ${zoneRes.status})`, hard: true };
	const zones = await zoneRes.json();
	if (!zones.success || zones.result.length === 0) {
		return { ok: false, detail: `no CF zone found for ${domain.domainname}`, hard: zones.success === true };
	}
	const zoneId = zones.result[0].id;

	const fqdn = domain.hostname === "@" ? domain.domainname : `${domain.hostname}.${domain.domainname}`;
	const recRes = await fetch(
		`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=${type}&name=${fqdn}`,
		{ signal, headers },
	);
	const recs = await recRes.json();

	let recordId;
	if (recs.success && recs.result.length > 0) {
		recordId = recs.result[0].id;
		if (recs.result[0].content === ip) {
			return { ok: true, detail: "nochg" };
		}
	} else {
		// record doesn't exist yet — create it
		const createRes = await fetch(
			`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
			{
				signal,
				method: "POST",
				headers,
				body: JSON.stringify({ type, name: fqdn, content: ip, ttl: 120, proxied: false }),
			},
		);
		const created = await createRes.json();
		if (!created.success) {
			return { ok: false, detail: JSON.stringify(created.errors).slice(0, 300) };
		}
		return { ok: true, detail: `created ${type} ${fqdn} -> ${ip}` };
	}

	const patchRes = await fetch(
		`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
		{
			signal,
			method: "PATCH",
			headers,
			body: JSON.stringify({ content: ip }),
		},
	);
	const patched = await patchRes.json();
	return {
		ok: !!patched.success,
		detail: patched.success ? `updated ${type} ${fqdn} -> ${ip}` : JSON.stringify(patched.errors ?? {}).slice(0, 300),
	};
}

const providers = new Map([
	["namecheap", updateNamecheap],
	["cloudflare", updateCloudflare],
	// deSEC (dedyn.io): implementation lives in ./dedyn.js — the update.dedyn.io
	// dynDNS endpoint, STS token verification and the TTL scope convention.
	["dedyn", updateDedyn],
	["duckdns", updateDuckdns],
	["porkbun", updatePorkbun],
	["digitalocean", updateDigitalOcean],
	["gandi", updateGandi],
	["afraid", updateAfraid],
	["noip", updateDyndns2],
	["dyndns2", updateDyndns2],
]);

const optionsOf = (service) => {
	try {
		return JSON.parse(service.options ?? "{}") ?? {};
	} catch {
		return {};
	}
};

export async function updateRecord(service, domain, ip, opts) {
	const fn = providers.get(service.provider);
	if (!fn) throw new Error(`unknown provider: ${service.provider}`);
	if (domain.record_type === "AAAA" && !CATALOG[service.provider]?.ipv6)
		return { ok: false, hard: true, detail: `${CATALOG[service.provider]?.label ?? service.provider} can't update AAAA records` };
	return fn(service, domain, ip, { ...opts, options: optionsOf(service) });
}

export { CATALOG, PROVIDERS };

// Pre-flight credential check when a service is added, before anything is stored.
// Takes RAW credentials (not the encrypted db fields) and returns { ok, detail };
// detail never contains the secret itself.
export async function verifyProvider({ provider, username, password, hostname, domainname, options }) {
	if (!PROVIDERS.includes(provider)) return { ok: false, detail: `unknown provider: ${provider}` };

	const opts = { hostname, domainname, signal: AbortSignal.timeout(10000) };
	if (provider === "dedyn") return verifyDedynToken(username, opts);
	if (provider === "duckdns") return verifyDuckdnsToken(username, opts);
	if (provider === "porkbun") return verifyPorkbunKeys(username, password, opts);
	if (provider === "digitalocean") return verifyDigitalOceanToken(username, opts);
	if (provider === "gandi") return verifyGandiToken(username, opts);
	if (provider === "afraid") return verifyAfraidToken(password, opts);
	if (provider === "noip" || provider === "dyndns2")
		return verifyDyndns2(provider, { username, password, options, ...opts });

	if (provider === "cloudflare") {
		if (!username) return { ok: false, detail: "cloudflare needs an API token" };
		try {
			const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
				headers: { Authorization: `Bearer ${username}`, "Content-Type": "application/json" },
				signal: AbortSignal.timeout(10000),
			});
			const j = await res.json().catch(() => ({}));
			return {
				ok: !!j.success,
				detail: j.success ? "valid Cloudflare token" : JSON.stringify(j.errors ?? {}).slice(0, 200),
			};
		} catch (err) {
			return { ok: false, detail: `cloudflare unreachable: ${err?.name ?? "error"}` };
		}
	}

	// namecheap: a per-domain DDNS key can only be proven on the update endpoint
	// itself, so its validation happens on the first scheduler pass.
	if (!password) return { ok: false, detail: "namecheap needs a DDNS key" };
	return { ok: true, detail: "key stored (verified on first update)" };
}

export { dedynScope };

// Re-verify only when an edit replaces a credential. A provider with two keys
// (Porkbun) is checked with the new one alongside the stored other one.
// Returns null when the edit touches no credential (nothing to check).
export async function verifyCredentialChange(service, domain, body) {
	const fields = (CATALOG[service.provider]?.fields ?? []).map((f) => f.name);
	const settings = (CATALOG[service.provider]?.settings ?? []).map((f) => f.name);
	const options = { ...optionsOf(service), ...Object.fromEntries(settings.filter((k) => body?.[k]).map((k) => [k, body[k]])) };
	if (!fields.some((f) => body?.[f]) && !settings.some((k) => body?.[k])) return null;
	const creds = Object.fromEntries(fields.map((f) => [f, body?.[f] || decryptSecret(service[f])]));
	return verifyProvider({
		provider: service.provider,
		...creds,
		options,
		hostname: domain?.hostname,
		domainname: domain?.domainname,
	});
}


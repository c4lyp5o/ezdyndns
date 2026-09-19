import { decryptSecret } from "../crypto";
import logger from "../logger";

// Provider adapters. Each returns { ok, detail }.
// Credentials go in headers / POST body — NEVER in the URL (the 2024 cdyndns bug).

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
	return { ok, detail: ok ? `updated ${domain.hostname}.${domain.domainname}` : body.slice(0, 300) };
}

async function updateCloudflare(service, domain, ip, { signal } = {}) {
	// Cloudflare DDNS via API v4: find the A record, PATCH it.
	// service.username = API token, service.password unused.
	// Zone is derived from the domain name.
	const headers = {
		Authorization: `Bearer ${decryptSecret(service.username)}`,
		"Content-Type": "application/json",
	};

	const zoneRes = await fetch(
		`https://api.cloudflare.com/client/v4/zones?name=${domain.domainname}`,
		{ signal, headers },
	);
	const zones = await zoneRes.json();
	if (!zones.success || zones.result.length === 0) {
		return { ok: false, detail: `no CF zone found for ${domain.domainname}` };
	}
	const zoneId = zones.result[0].id;

	const fqdn = `${domain.hostname}.${domain.domainname}`;
	const recRes = await fetch(
		`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${fqdn}`,
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
				body: JSON.stringify({ type: "A", name: fqdn, content: ip, ttl: 120, proxied: false }),
			},
		);
		const created = await createRes.json();
		if (!created.success) {
			return { ok: false, detail: JSON.stringify(created.errors).slice(0, 300) };
		}
		return { ok: true, detail: `created A ${fqdn} -> ${ip}` };
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
		ok: patched.success,
		detail: patched.success ? `updated A ${fqdn} -> ${ip}` : JSON.stringify(patched.errors).slice(0, 300),
	};
}

const providers = new Map([
	["namecheap", updateNamecheap],
	["cloudflare", updateCloudflare],
]);

export async function updateRecord(service, domain, ip, opts) {
	const fn = providers.get(service.provider);
	if (!fn) throw new Error(`unknown provider: ${service.provider}`);
	return fn(service, domain, ip, opts);
}
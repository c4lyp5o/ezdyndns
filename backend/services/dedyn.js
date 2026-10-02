import { decryptSecret } from "../crypto";
import logger from "../logger";

// deNIC / deSEC STS token for an ezdyndns `services` row (namecheap-style creds).
// Scope: domain, update, ttl, ip4 (and optionally ip6). Never printed.
export function dedynScope(service) {
	const ttl = Math.max(60, Math.min(240, Number(service.interval_sec ?? 300)));
	return ["domain", "update", "ttl", "ip4", process.env.EZDYNDNS_DEDYN_IP6 ? "ip6" : null]
		.filter(Boolean)
		.map((s) => `${s} ${ttl}`)
		.join(" ");
}

// Validate a candidate token by exercising the dynDNS update endpoint itself.
// Verified live 2026-10-02: GET /api/v1/tokens/self/ answers 404 for BOTH unknown AND
// valid update-scoped tokens, so the REST API cannot verify this credential — only the
// update endpoint can (dyndns2 contract: 200 + body `good`).
// Without ip= the endpoint uses the connection IP, and without hostname it falls back to
// the account's single host — so the probe idempotently asserts the record we manage.
// Rate budget: deSEC allows 2 dyndns requests / 2 min per account (sliding window);
// the gate spends exactly 1 and maps 429 to "retry later", never to "bad token".
// Returns { ok, detail }; detail never contains the token.
export async function verifyDedynToken(token, { hostname, domainname, signal } = {}) {
	if (!token) return { ok: false, detail: "no token" };
	const fqdn =
		hostname && domainname
			? hostname === "@"
				? domainname
				: `${hostname}.${domainname}`
			: null;
	const u = new URL("https://update.dedyn.io/ezdyndns");
	if (fqdn) u.searchParams.set("hostname", fqdn);
	let res;
	try {
		res = await fetch(u, { headers: { Authorization: `Token ${token}` }, signal });
	} catch (err) {
		return { ok: false, detail: `desec unreachable: ${err?.name ?? "error"}` };
	}
	const body = (await res.text().catch(() => "")).trim();
	if (res.ok && body.startsWith("good"))
		return { ok: true, detail: `valid deSEC token; ${fqdn ?? "record"} points at this server` };
	if (res.status === 429)
		return { ok: false, detail: `deSEC rate limit — ${body || "retry in ~2 min"}` };
	if (res.status === 401 || res.status === 403)
		// deSEC's generic auth-failure body ("No username URL parameter provided.") appears
		// even with a hostname — it means credentials were rejected.
		return { ok: false, detail: "invalid token (deSEC 401)" };
	return { ok: false, detail: `deSEC ${res.status}: ${body.slice(0, 160)}` };
}

export async function updateDedyn(service, domain, ip, { signal } = {}) {
	const token = decryptSecret(service.username);
	if (!token) return { ok: false, detail: "missing deSEC token" };
	const hostname =
		domain.hostname === "@" ? domain.domainname : `${domain.hostname}.${domain.domainname}`;

	const u = new URL("https://update.dedyn.io/ezdyndns");
	u.searchParams.set("hostname", hostname);
	if (ip?.includes(".")) u.searchParams.set("ip", ip);
	if (process.env.EZDYNDNS_DEDYN_IP6) u.searchParams.set("ip6", process.env.EZDYNDNS_DEDYN_IP6);

	const fqdn = hostname;
	const probe = (status) =>
		fetch(`https://desec.io/api/v1/domains/${fqdn}/`, {
			headers: { Authorization: `Token ${token}` },
			signal: AbortSignal.timeout(5000),
		})
			.then((r) => r.status)
			.catch(() => "ERR");

	let res;
	try {
		res = await fetch(u, { headers: { Authorization: `Token ${token}` }, signal });
	} catch (err) {
		return { ok: false, detail: `update.dedyn.io: ${err?.name ?? "error"}` };
	}
	const body = await res.text();

	if (res.ok) return { ok: true, detail: body.trim() || `updated ${hostname}` };

	// Diagnose 4xx without leaking the token: which side is wrong?
	const parts = [];
	if (res.status === 401 || res.status === 403) parts.push("token rejected");
	else parts.push(`HTTP ${res.status}: ${body.slice(0, 80)}`);
	if (res.status === 429) parts.push("rate-limited: deSEC allows 2 updates/2min; next cycle will retry");
	else {
		const domainStatus = await probe(res.status);
		if (domainStatus === 404) parts.push(`domain ${fqdn} not owned by this token`);
		else if (domainStatus !== 200) parts.push(`domain read-back HTTP ${domainStatus}`);
	}
	const detail = parts.join(" | ");
	logger.warn(`[PROVIDER] dedyn ${hostname}: ${detail}`);
	return { ok: false, detail };
}

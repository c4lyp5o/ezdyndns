import { decryptSecret } from "../crypto";
import logger from "../logger";

// FreeDNS (afraid.org). Each record has its own update URL,
// https://freedns.afraid.org/dynamic/update.php?<token>, and `&address=<ip>`
// sets the address; a reply with "Updated" means success. This is the contract
// ddclient's freedns protocol uses (FreeDNS publishes no API spec). The token is
// the whole credential, so the URL is never logged.
// FreeDNS asks clients not to resend an unchanged IP; the catalog marks it
// pushOnChange so the scheduler skips same-IP cycles.

// Accept the pasted update URL or the bare token.
export function afraidToken(raw) {
	const value = String(raw ?? "").trim();
	const fromUrl = value.match(/update\.php\?([^&\s]+)/);
	const token = fromUrl ? fromUrl[1] : value;
	return /^[A-Za-z0-9=_-]{8,}$/.test(token) ? token : null;
}

async function call(token, ip, signal) {
	const url = `https://freedns.afraid.org/dynamic/update.php?${token}${ip ? `&address=${encodeURIComponent(ip)}` : ""}`;
	const res = await fetch(url, { signal, headers: { "User-Agent": "ezdyndns" } });
	const body = (await res.text()).trim();
	return { res, body, line: body.split("\n")[0].slice(0, 200) };
}

const unchanged = (body) => /has not changed/i.test(body);

// No read-only check exists: the probe is one real update to the connection IP,
// which is this server's public IP.
export async function verifyAfraidToken(raw, { signal } = {}) {
	const token = afraidToken(raw);
	if (!token) return { ok: false, detail: "paste the record's update URL or the token after update.php?" };
	try {
		const { res, body, line } = await call(token, null, signal);
		if (res.ok && (/Updated/i.test(body) || unchanged(body))) return { ok: true, detail: `valid FreeDNS token; ${line}` };
		return { ok: false, detail: `FreeDNS: ${line || `HTTP ${res.status}`}` };
	} catch (err) {
		return { ok: false, detail: `afraid.org unreachable: ${err?.name ?? "error"}` };
	}
}

export async function updateAfraid(service, domain, ip, { signal } = {}) {
	const token = afraidToken(decryptSecret(domain.password ?? service.password));
	if (!token) return { ok: false, detail: "missing FreeDNS update token" };
	const fqdn = domain.hostname === "@" ? domain.domainname : `${domain.hostname}.${domain.domainname}`;
	const { res, body, line } = await call(token, ip, signal);
	if (res.ok && unchanged(body)) return { ok: true, detail: "nochg" };
	if (res.ok && /Updated/i.test(body)) {
		// The reply names the host it changed; a token copied from another record
		// would silently move that record instead.
		if (!body.toLowerCase().includes(fqdn.toLowerCase()))
			return fail(fqdn, { detail: `token belongs to another record: ${line}`, hard: true });
		return { ok: true, detail: line };
	}
	// "ERROR: Unable to locate this record" and friends need a new token.
	if (res.ok && /^ERROR/i.test(line)) return fail(fqdn, { detail: line, hard: true });
	return fail(fqdn, { detail: line || `HTTP ${res.status}`, retryAfter: res.status >= 500 ? 900 : undefined });
}

function fail(fqdn, result) {
	logger.warn(`[PROVIDER] afraid ${fqdn}: ${result.detail}`);
	return { ok: false, ...result };
}

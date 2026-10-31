import { promises as dns } from "node:dns";
import net, { isIP } from "node:net";

// DNS lookups for the toolbox and the per-record "does it resolve?" check.
// Plain DNS over UDP/TCP 53 (node:dns), straight to named servers: three
// public resolvers for what the world sees, and the zone's own nameservers
// for what is published right now.
export const PUBLIC_RESOLVERS = [
	{ name: "Cloudflare", ip: "1.1.1.1" },
	{ name: "Google", ip: "8.8.8.8" },
	{ name: "Quad9", ip: "9.9.9.9" },
];
export const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "CAA", "SRV", "PTR"];
const MAX_AUTHORITATIVE = 4;

const resolvers = new Map();
function resolverAt(ip) {
	if (!resolvers.has(ip)) {
		const r = new dns.Resolver({ timeout: 2500, tries: 1 });
		r.setServers([ip]);
		resolvers.set(ip, r);
	}
	return resolvers.get(ip);
}
const primary = () => resolverAt(PUBLIC_RESOLVERS[0].ip);

// A hostname we are willing to send out: letters, digits, hyphen, underscore
// (for _dmarc / _domainkey / SRV names), 253 characters at most.
export function cleanName(raw) {
	const name = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
	if (!name || name.length > 253) return null;
	const labels = name.split(".");
	if (labels.length < 2) return null;
	return labels.every((l) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l)) ? name : null;
}

const NO_ANSWER = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);
const reason = (code) =>
	({
		ENOTFOUND: "name does not exist",
		NXDOMAIN: "name does not exist",
		ENODATA: "no record of this type",
		ETIMEOUT: "timed out",
		ECONNREFUSED: "refused",
		ESERVFAIL: "server failure",
		EREFUSED: "refused",
	})[code] ?? code;

// ---------- TXT over TCP ----------
// Bun's resolveTxt keeps only the first character-string of each TXT record,
// so a long SPF or DKIM record split into 255-byte strings comes back cut off.
// TXT questions are asked here instead: one DNS query over TCP (no UDP
// truncation either), answer strings joined as RFC 7208 says.

export function encodeQuery(name, qtype, id = Math.floor(Math.random() * 0xffff)) {
	const labels = name.split(".").filter(Boolean);
	const qname = Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "ascii")])), Buffer.from([0])]);
	const header = Buffer.alloc(12);
	header.writeUInt16BE(id, 0);
	header.writeUInt16BE(0x0100, 2); // standard query, recursion desired
	header.writeUInt16BE(1, 4); // one question
	const tail = Buffer.alloc(4);
	tail.writeUInt16BE(qtype, 0);
	tail.writeUInt16BE(1, 2); // class IN
	return Buffer.concat([header, qname, tail]);
}

// Skip a (possibly compressed) name; returns the offset after it.
function skipName(buf, off) {
	while (off < buf.length) {
		const len = buf[off];
		if (len === 0) return off + 1;
		if ((len & 0xc0) === 0xc0) return off + 2;
		off += len + 1;
	}
	throw new Error("bad name");
}

// TXT answers from a DNS response: { rcode, records: [{ text, ttl }] }.
export function decodeTxt(buf) {
	const rcode = buf.readUInt16BE(2) & 0x0f;
	const qd = buf.readUInt16BE(4);
	const an = buf.readUInt16BE(6);
	let off = 12;
	for (let i = 0; i < qd; i++) off = skipName(buf, off) + 4;
	const records = [];
	for (let i = 0; i < an; i++) {
		off = skipName(buf, off);
		const type = buf.readUInt16BE(off);
		const ttl = buf.readUInt32BE(off + 4);
		const rdlen = buf.readUInt16BE(off + 8);
		off += 10;
		if (type === 16) {
			const parts = [];
			for (let p = off; p < off + rdlen; ) {
				const len = buf[p];
				parts.push(buf.subarray(p + 1, p + 1 + len).toString("utf8"));
				p += len + 1;
			}
			records.push({ text: parts.join(""), ttl });
		}
		off += rdlen;
	}
	return { rcode, records };
}

function txtOverTcp(server, name, timeoutMs = 3000) {
	return new Promise((resolve, reject) => {
		const query = encodeQuery(name, 16);
		const framed = Buffer.concat([Buffer.from([query.length >> 8, query.length & 0xff]), query]);
		let data = Buffer.alloc(0);
		const sock = net.connect(53, server, () => sock.write(framed));
		const fail = (code) => {
			sock.destroy();
			reject(Object.assign(new Error(code), { code }));
		};
		sock.setTimeout(timeoutMs, () => fail("ETIMEOUT"));
		sock.on("error", (err) => fail(err.code === "ECONNREFUSED" ? "ECONNREFUSED" : "ESERVFAIL"));
		sock.on("data", (chunk) => {
			data = Buffer.concat([data, chunk]);
			if (data.length >= 2 && data.length >= 2 + data.readUInt16BE(0)) {
				sock.end();
				try {
					resolve(decodeTxt(data.subarray(2, 2 + data.readUInt16BE(0))));
				} catch {
					reject(Object.assign(new Error("ESERVFAIL"), { code: "ESERVFAIL" }));
				}
			}
		});
	});
}

// The address a Resolver was pointed at (each one here has exactly one).
const serverOf = (resolver) => resolver.getServers()[0]?.replace(/:53$/, "");

// One question to one server: { values: string[], ttl, error }.
export async function ask(resolver, name, type) {
	if (type === "TXT") {
		try {
			const { rcode, records } = await txtOverTcp(serverOf(resolver), name);
			if (rcode === 3) return { values: [], empty: reason("ENOTFOUND") };
			if (rcode !== 0) return { values: [], error: reason(rcode === 5 ? "EREFUSED" : "ESERVFAIL") };
			if (records.length === 0) return { values: [], empty: reason("ENODATA") };
			return { values: records.map((r) => r.text), ttl: Math.min(...records.map((r) => r.ttl)) };
		} catch (err) {
			return { values: [], error: reason(err.code ?? err.message) };
		}
	}
	try {
		switch (type) {
			case "A":
			case "AAAA": {
				const rows = await (type === "A" ? resolver.resolve4(name, { ttl: true }) : resolver.resolve6(name, { ttl: true }));
				return { values: rows.map((r) => r.address), ttl: rows.length ? Math.min(...rows.map((r) => r.ttl)) : null };
			}
			case "CNAME":
				return { values: await resolver.resolveCname(name) };
			case "MX":
				return {
					values: (await resolver.resolveMx(name))
						.sort((a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange))
						.map((m) => `${m.priority} ${m.exchange}`),
				};
			case "NS":
				return { values: (await resolver.resolveNs(name)).sort() };
			case "SOA": {
				const s = await resolver.resolveSoa(name);
				return { values: [`${s.nsname} ${s.hostmaster} ${s.serial} ${s.refresh} ${s.retry} ${s.expire} ${s.minttl}`] };
			}
			case "CAA":
				return {
					values: (await resolver.resolveCaa(name)).map((c) => {
						const tag = Object.keys(c).find((k) => k !== "critical");
						return `${c.critical ?? 0} ${tag} "${c[tag]}"`;
					}),
				};
			case "SRV":
				return {
					values: (await resolver.resolveSrv(name)).map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`),
				};
			case "PTR":
				return { values: isIP(name) ? await resolver.reverse(name) : await resolver.resolvePtr(name) };
			default:
				return { values: [], error: `unsupported type ${type}` };
		}
	} catch (err) {
		if (NO_ANSWER.has(err.code)) return { values: [], empty: reason(err.code) };
		return { values: [], error: reason(err.code ?? err.message) };
	}
}

// The closest enclosing zone and its nameservers' addresses.
export async function authoritativeServers(name) {
	const labels = name.split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		const zone = labels.slice(i).join(".");
		const ns = await ask(primary(), zone, "NS");
		if (ns.values.length === 0) continue;
		const servers = await Promise.all(
			ns.values.slice(0, MAX_AUTHORITATIVE).map(async (host) => {
				const a = await ask(primary(), host, "A");
				return a.values[0] ? { name: host, ip: a.values[0] } : null;
			}),
		);
		return { zone, servers: servers.filter(Boolean) };
	}
	return { zone: null, servers: [] };
}

const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// Every public resolver plus every authoritative server, side by side.
export async function lookup(name, type) {
	const [pub, auth] = await Promise.all([
		Promise.all(PUBLIC_RESOLVERS.map(async (r) => ({ server: r.name, ip: r.ip, ...(await ask(resolverAt(r.ip), name, type)) }))),
		type === "PTR"
			? Promise.resolve({ zone: null, servers: [] })
			: authoritativeServers(name),
	]);
	const authoritative = await Promise.all(
		auth.servers.map(async (s) => ({ server: s.name, ip: s.ip, ...(await ask(resolverAt(s.ip), name, type)) })),
	);
	const answered = [...pub, ...authoritative].filter((r) => !r.error);
	return {
		name,
		type,
		zone: auth.zone,
		public: pub,
		authoritative,
		consistent: answered.length > 0 && answered.every((r) => same(r.values, answered[0].values)),
	};
}

// Does a managed record resolve to what we pushed? Verdicts:
//   resolves     authoritative and public answers all hold the expected IP
//   propagating  authoritative is right, a public resolver still caches the old one
//   mismatch     an authoritative server answers something else
//   unknown      no authoritative server answered (or nothing was expected)
export function verdictFor(result, expected) {
	if (!expected) return "unknown";
	const auth = result.authoritative.filter((r) => !r.error);
	if (auth.length === 0) return "unknown";
	if (!auth.every((r) => r.values.includes(expected))) return "mismatch";
	const pub = result.public.filter((r) => !r.error);
	return pub.every((r) => r.values.includes(expected)) ? "resolves" : "propagating";
}

export async function checkRecord(fqdn, type, expected) {
	const result = await lookup(fqdn, type);
	return { verdict: verdictFor(result, expected), result };
}

// ---------- mail: MX, SPF, DMARC, DKIM ----------

const txt = async (name) => (await ask(primary(), name, "TXT")).values;

// SPF terms that cost a DNS lookup (RFC 7208 §4.6.4 caps a check at 10).
const LOOKUP_TERMS = /^[+?~-]?(include:|a\b|a:|a\/|mx\b|mx:|mx\/|ptr\b|ptr:|exists:)|^redirect=/i;

export function parseSpf(record) {
	const terms = record.split(/\s+/).slice(1).filter(Boolean);
	const all = terms.find((t) => /^[+?~-]?all$/i.test(t));
	return { terms, all: all ?? null };
}

async function spfLookups(domain, depth = 0, seen = new Set()) {
	if (depth > 10 || seen.has(domain)) return { count: 0, loops: seen.has(domain) };
	seen.add(domain);
	const record = (await txt(domain)).find((t) => /^v=spf1(\s|$)/i.test(t));
	if (!record) return { count: 0, missing: [domain] };
	let count = 0;
	const missing = [];
	for (const term of parseSpf(record).terms) {
		if (!LOOKUP_TERMS.test(term)) continue;
		count += 1;
		const target = term.match(/^[+?~-]?include:(.+)$/i)?.[1] ?? term.match(/^redirect=(.+)$/i)?.[1];
		if (target && cleanName(target)) {
			const nested = await spfLookups(cleanName(target), depth + 1, seen);
			count += nested.count;
			missing.push(...(nested.missing ?? []));
		}
	}
	return { count, missing };
}

export function parseTags(record) {
	return Object.fromEntries(
		record
			.split(";")
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => {
				const i = p.indexOf("=");
				return i === -1 ? [p.toLowerCase(), ""] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
			}),
	);
}

// Rough RSA size from the DER-encoded public key length.
function keyBits(p) {
	const bytes = Math.floor((p.replace(/\s/g, "").length * 3) / 4);
	if (bytes === 0) return 0;
	if (bytes < 120) return 512;
	if (bytes < 200) return 1024;
	if (bytes < 330) return 2048;
	if (bytes < 600) return 4096;
	return bytes * 8;
}

export async function mailReport(domain, selector) {
	const [mxRaw, txts, dmarcTxts, dkimTxts] = await Promise.all([
		ask(primary(), domain, "MX"),
		txt(domain),
		txt(`_dmarc.${domain}`),
		selector ? txt(`${selector}._domainkey.${domain}`) : Promise.resolve([]),
	]);

	const mx = await Promise.all(
		mxRaw.values.map(async (v) => {
			const [priority, exchange] = v.split(" ");
			const [a, aaaa] = await Promise.all([ask(primary(), exchange, "A"), ask(primary(), exchange, "AAAA")]);
			return { priority: Number(priority), exchange, addresses: [...a.values, ...aaaa.values] };
		}),
	);
	const mxNotes = [];
	if (mxRaw.error) mxNotes.push({ level: "bad", text: `MX lookup failed: ${mxRaw.error}` });
	else if (mx.length === 0) mxNotes.push({ level: "warn", text: "No MX records: mail goes to the A record, or nowhere." });
	if (mx.length === 1 && mx[0].exchange === "") mxNotes.push({ level: "ok", text: "Null MX: this domain accepts no mail." });
	for (const m of mx)
		if (m.exchange && m.addresses.length === 0) mxNotes.push({ level: "bad", text: `${m.exchange} has no address.` });

	const spfRecords = txts.filter((t) => /^v=spf1(\s|$)/i.test(t));
	const spfNotes = [];
	let spf = null;
	if (spfRecords.length === 0) spfNotes.push({ level: "warn", text: "No SPF record." });
	if (spfRecords.length > 1) spfNotes.push({ level: "bad", text: `${spfRecords.length} SPF records; receivers treat that as a permanent error.` });
	if (spfRecords.length >= 1) {
		const parsed = parseSpf(spfRecords[0]);
		const lookups = await spfLookups(domain);
		spf = { record: spfRecords[0], terms: parsed.terms, lookups: lookups.count };
		if (lookups.count > 10) spfNotes.push({ level: "bad", text: `${lookups.count} DNS lookups; the limit is 10.` });
		else spfNotes.push({ level: "ok", text: `${lookups.count} of 10 DNS lookups.` });
		for (const m of lookups.missing ?? []) if (m !== domain) spfNotes.push({ level: "bad", text: `include ${m} has no SPF record.` });
		if (!parsed.all && !parsed.terms.some((t) => /^redirect=/i.test(t)))
			spfNotes.push({ level: "warn", text: "No all mechanism; unlisted senders get a neutral result." });
		else if (/^\+?all$/i.test(parsed.all ?? "")) spfNotes.push({ level: "bad", text: "+all lets anyone send as this domain." });
		else if (/^\?all$/i.test(parsed.all ?? "")) spfNotes.push({ level: "warn", text: "?all is neutral: unlisted senders aren't rejected." });
	}

	const dmarcRecord = dmarcTxts.find((t) => /^v=DMARC1/i.test(t)) ?? null;
	const dmarcNotes = [];
	let dmarc = null;
	if (!dmarcRecord) dmarcNotes.push({ level: "warn", text: `No DMARC record at _dmarc.${domain}.` });
	else {
		const tags = parseTags(dmarcRecord);
		dmarc = { record: dmarcRecord, tags };
		if (!tags.p) dmarcNotes.push({ level: "bad", text: "No p= policy." });
		else if (tags.p === "none") dmarcNotes.push({ level: "warn", text: "p=none only monitors; failing mail is still delivered." });
		else dmarcNotes.push({ level: "ok", text: `p=${tags.p}${tags.pct && tags.pct !== "100" ? ` on ${tags.pct}% of mail` : ""}.` });
		if (!tags.rua) dmarcNotes.push({ level: "warn", text: "No rua= address, so no aggregate reports." });
	}

	let dkim = null;
	const dkimNotes = [];
	if (selector) {
		const record = dkimTxts.find((t) => /(^|;)\s*p=/i.test(t)) ?? null;
		if (!record) dkimNotes.push({ level: "bad", text: `No DKIM key at ${selector}._domainkey.${domain}.` });
		else {
			const tags = parseTags(record);
			const bits = keyBits(tags.p ?? "");
			dkim = { selector, record, tags, bits };
			if (!tags.p) dkimNotes.push({ level: "bad", text: "Empty p=: this key is revoked." });
			else if (bits < 1024) dkimNotes.push({ level: "bad", text: `About ${bits}-bit key; use 2048.` });
			else if (bits < 2048) dkimNotes.push({ level: "warn", text: `About ${bits}-bit key; 2048 is recommended.` });
			else dkimNotes.push({ level: "ok", text: `About ${bits}-bit ${tags.k ?? "rsa"} key.` });
		}
	}

	return { domain, mx, mxNotes, spf, spfNotes, dmarc, dmarcNotes, selector: selector ?? null, dkim, dkimNotes };
}

// ---------- reverse DNS ----------

export async function reverseReport(ip) {
	const ptr = await ask(primary(), ip, "PTR");
	const family = isIP(ip) === 6 ? "AAAA" : "A";
	const names = await Promise.all(
		ptr.values.map(async (name) => {
			const fwd = await ask(primary(), name, family);
			return { name, addresses: fwd.values, confirmed: fwd.values.includes(ip) };
		}),
	);
	return { ip, names, error: ptr.error ?? null, empty: ptr.empty ?? null };
}

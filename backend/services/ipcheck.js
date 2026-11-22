import { isIPv4, isIPv6 } from "node:net";
import logger from "../logger";

// Every source is asked at once and the answer needs two of them to agree, so
// one broken or tampered responder can't repoint every record. A lone answer
// is accepted only when it matches the last known IP (nothing would change).
// Six sources across four operators (Google, Cloudflare, AWS, Hetzner), two
// per operator at most: the quorum has to survive one operator, or one ISP's
// DNS filtering, having a bad night. ipify and api.myip.com are gone — Maxis
// DNS answers ipify with mcmc-redirect.maxis.com.my (times out), and
// api.myip.com completes TLS then never sends a response.
const IPV4_SOURCES = [
	{ url: "https://ipinfo.io/json", extract: (d) => d.ip, name: "ipinfo" },
	{ url: "https://ifconfig.me/all.json", extract: (d) => d.ip_addr, name: "ifconfigme" },
	{ url: "https://ipv4.icanhazip.com", text: true, name: "icanhazip" },
	{ url: "https://api.ip.sb/ip", text: true, name: "ipsb" },
	{ url: "https://checkip.amazonaws.com", text: true, name: "checkip-aws" },
	{ url: "https://ipv4.ident.me", text: true, name: "identme" },
];

// IPv6-only hostnames, asked only when an active AAAA record exists. api6.ipify.org
// is filtered to the same Maxis redirect as its IPv4 sibling, so it is out.
const IPV6_SOURCES = [
	{ url: "https://v6.ident.me", text: true, name: "ident6" },
	{ url: "https://ipv6.icanhazip.com", text: true, name: "icanhazip6" },
	{ url: "https://ipv6.whatismyip.akamai.com", text: true, name: "akamai6" },
];

async function ask(src, valid, signal) {
	const res = await fetch(src.url, {
		signal: signal ?? AbortSignal.timeout(5000),
		headers: { "User-Agent": "ezdyndns" },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const ip = src.text ? (await res.text()).trim() : src.extract(await res.json());
	if (!valid(ip)) throw new Error(`not an address: ${String(ip).slice(0, 40)}`);
	return ip;
}

// Pure decision over the answers, exported for tests.
// answers: [{ name, ip }] from the sources that replied.
export function decide(answers, last, { quorum = 2 } = {}) {
	const votes = new Map();
	for (const a of answers) votes.set(a.ip, [...(votes.get(a.ip) ?? []), a.name]);
	const ranked = [...votes.entries()].sort((x, y) => y[1].length - x[1].length);
	const [top, second] = ranked;
	if (top && top[1].length >= quorum && !(second && second[1].length === top[1].length))
		return { ip: top[0], source: top[1].join("+"), agreed: top[1].length };
	if (answers.length === 1 && answers[0].ip === last)
		return { ip: last, source: answers[0].name, agreed: 1 };
	if (answers.length === 0) throw new Error("all IP check services failed");
	const seen = ranked.map(([ip, names]) => `${ip} (${names.join(", ")})`).join(" vs ");
	throw new Error(`IP sources disagree or only one answered: ${seen}`);
}

async function poll(sources, valid, signal) {
	const settled = await Promise.allSettled(sources.map((s) => ask(s, valid, signal)));
	const answers = [];
	settled.forEach((r, i) => {
		if (r.status === "fulfilled") answers.push({ name: sources[i].name, ip: r.value });
		else logger.warn(`[IPCHECK] ${sources[i].name} failed: ${r.reason?.message}`);
	});
	return answers;
}

// A single blip where every source times out at once (WAN re-dial, packet
// loss) must not cost a whole cycle or page anyone: ask once more before
// giving up.
const RETRY_DELAY_MS = 3000;

export async function pollWithRetry(sources, valid, { signal, delayMs = RETRY_DELAY_MS, pollFn = poll } = {}) {
	let answers = await pollFn(sources, valid, signal);
	if (answers.length === 0 && !signal?.aborted) {
		logger.warn("[IPCHECK] no source answered; retrying once");
		await new Promise((r) => setTimeout(r, delayMs));
		if (!signal?.aborted) answers = await pollFn(sources, valid, signal);
	}
	return answers;
}

export async function getPublicIp({ last, signal } = {}) {
	const result = decide(await pollWithRetry(IPV4_SOURCES, isIPv4, { signal }), last);
	logger.info(`[IPCHECK] ${result.ip} from ${result.source}`);
	return result;
}

// Few IPv6 echo services exist, so one valid answer is enough; two that
// disagree is still an error. No retry: a host without IPv6 pays this
// timeout every cycle, and a missing AAAA address is handled downstream.
export async function getPublicIp6({ last, signal } = {}) {
	const answers = await poll(IPV6_SOURCES, isIPv6, signal);
	const result = decide(answers, last, { quorum: Math.min(2, Math.max(answers.length, 1)) });
	logger.info(`[IPCHECK] IPv6 ${result.ip} from ${result.source}`);
	return result;
}

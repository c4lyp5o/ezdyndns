import { isIPv4, isIPv6 } from "node:net";
import logger from "../logger";

// Every source is asked at once and the answer needs two of them to agree, so
// one broken or tampered responder can't repoint every record. A lone answer
// is accepted only when it matches the last known IP (nothing would change).
const IPV4_SOURCES = [
	{ url: "https://ipinfo.io/json", extract: (d) => d.ip, name: "ipinfo" },
	{ url: "https://api.ipify.org?format=json", extract: (d) => d.ip, name: "ipify" },
	{ url: "https://api.myip.com", extract: (d) => d.ip, name: "myip" },
	{ url: "https://ifconfig.me/all.json", extract: (d) => d.ip_addr, name: "ifconfigme" },
];

// IPv6-only hostnames, asked only when an active AAAA record exists.
const IPV6_SOURCES = [
	{ url: "https://api6.ipify.org?format=json", extract: (d) => d.ip, name: "ipify6" },
	{ url: "https://v6.ident.me", text: true, name: "ident6" },
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

export async function getPublicIp({ last, signal } = {}) {
	const result = decide(await poll(IPV4_SOURCES, isIPv4, signal), last);
	logger.info(`[IPCHECK] ${result.ip} from ${result.source}`);
	return result;
}

// Few IPv6 echo services exist, so one valid answer is enough; two that
// disagree is still an error.
export async function getPublicIp6({ last, signal } = {}) {
	const answers = await poll(IPV6_SOURCES, isIPv6, signal);
	const result = decide(answers, last, { quorum: Math.min(2, Math.max(answers.length, 1)) });
	logger.info(`[IPCHECK] IPv6 ${result.ip} from ${result.source}`);
	return result;
}

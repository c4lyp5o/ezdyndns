import logger from "../logger";

// Ordered fallback chain: first service to answer wins.
const IPCHECK_SERVICES = [
	{ url: "https://ipinfo.io/json", extract: (d) => d.ip, name: "ipinfo" },
	{ url: "https://api.ipify.org?format=json", extract: (d) => d.ip, name: "ipify" },
	{ url: "https://api.myip.com", extract: (d) => d.ip, name: "myip" },
	{ url: "https://ifconfig.me/all.json", extract: (d) => d.ip_addr, name: "ifconfigme" },
];

export async function getPublicIp({ signal } = {}) {
	for (const svc of IPCHECK_SERVICES) {
		try {
			const res = await fetch(svc.url, {
				signal: signal ?? AbortSignal.timeout(5000),
				headers: { "User-Agent": "ezdyndns/0.1" },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const ip = svc.extract(data);
			if (typeof ip === "string" && ip.length > 0) {
				logger.info(`[IPCHECK] got ${ip} from ${svc.name}`);
				return { ip, source: svc.name };
			}
		} catch (err) {
			logger.warn(`[IPCHECK] ${svc.name} failed: ${err.message}`);
		}
	}
	throw new Error("all IP check services failed");
}
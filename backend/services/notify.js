import logger from "../logger";

// Fan-out notifications. Each channel is on when its env var is set:
//   EZDYNDNS_NTFY_URL            full ntfy topic URL, e.g. https://ntfy.example.com/ezdyndns
//   EZDYNDNS_WEBHOOK_URL         POST {event, title, message, priority, tags} as JSON
//   EZDYNDNS_DISCORD_WEBHOOK_URL Discord channel webhook
//   EZDYNDNS_GOTIFY_URL + EZDYNDNS_GOTIFY_TOKEN   Gotify server and application token
// Every send is fire-and-forget: a push outage must never break the update cycle.
const env = (k) => process.env[k] || "";

const GOTIFY_PRIORITY = { min: 1, low: 3, default: 5, high: 8, urgent: 10 };

export function channels() {
	const list = [];
	// ntfy renders emoji from the Tags header (e.g. "globe" -> 🌐), so titles stay
	// plain ASCII: HTTP header values must be latin-1, and an emoji in Title makes
	// fetch() throw synchronously ("Header 'Title' has invalid value").
	if (env("EZDYNDNS_NTFY_URL"))
		list.push({
			name: "ntfy",
			request: (n) => [
				env("EZDYNDNS_NTFY_URL"),
				{
					method: "POST",
					body: n.message,
					headers: { Title: n.title, Priority: n.priority, ...(n.tags ? { Tags: n.tags } : {}) },
				},
			],
		});
	if (env("EZDYNDNS_WEBHOOK_URL"))
		list.push({
			name: "webhook",
			request: (n) => [
				env("EZDYNDNS_WEBHOOK_URL"),
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(n) },
			],
		});
	if (env("EZDYNDNS_DISCORD_WEBHOOK_URL"))
		list.push({
			name: "discord",
			request: (n) => [
				env("EZDYNDNS_DISCORD_WEBHOOK_URL"),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					// Discord caps content at 2000 characters.
					body: JSON.stringify({ content: `**${n.title}**\n${n.message}`.slice(0, 2000) }),
				},
			],
		});
	if (env("EZDYNDNS_GOTIFY_URL") && env("EZDYNDNS_GOTIFY_TOKEN"))
		list.push({
			name: "gotify",
			request: (n) => [
				`${env("EZDYNDNS_GOTIFY_URL").replace(/\/+$/, "")}/message`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Gotify-Key": env("EZDYNDNS_GOTIFY_TOKEN") },
					body: JSON.stringify({ title: n.title, message: n.message, priority: GOTIFY_PRIORITY[n.priority] ?? 5 }),
				},
			],
		});
	return list;
}

let warned = false;

// event: a short machine name for webhook consumers (ip-changed, update-failed,
// recovered, needs-attention, stalled).
export function notify(title, message, { priority = "default", tags = "", event = "notice" } = {}) {
	const targets = channels();
	if (targets.length === 0) {
		if (!warned) logger.warn("[NOTIFY] no notification channel configured; notifications are skipped");
		warned = true;
		return;
	}
	const n = { event, title, message, priority, tags };
	for (const ch of targets) {
		try {
			const [url, init] = ch.request(n);
			fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
				.then((res) => {
					if (!res.ok) logger.error(`[NOTIFY] ${ch.name} answered HTTP ${res.status}`);
				})
				.catch((err) => logger.error(`[NOTIFY] ${ch.name} push failed: ${err.message}`));
		} catch (err) {
			// fetch() throws synchronously on invalid header values.
			logger.error(`[NOTIFY] ${ch.name} push rejected: ${err.message}`);
		}
	}
}

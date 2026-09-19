import logger from "../logger";

// EZDYNDNS_NTFY_URL is the full topic URL, e.g.
// https://ntfy.example.com/ezdyndns
const url = process.env.EZDYNDNS_NTFY_URL;

// ntfy renders emoji from the Tags header (e.g. "globe" -> 🌐), so titles stay
// plain ASCII: HTTP header values must be latin-1, and an emoji in Title makes
// fetch() throw synchronously ("Header 'Title' has invalid value").
export function notify(title, message, { priority = "default", tags = "" } = {}) {
	if (!url) {
		logger.warn("[NTFY] EZDYNDNS_NTFY_URL not set — notification skipped");
		return;
	}
	try {
		// Fire-and-forget: a push outage must never break the update cycle.
		fetch(url, {
			method: "POST",
			body: message,
			headers: {
				Title: title,
				Priority: priority,
				...(tags ? { Tags: tags } : {}),
			},
			signal: AbortSignal.timeout(5000),
		}).catch((err) => logger.error(`[NTFY] push failed: ${err.message}`));
	} catch (err) {
		// fetch() throws synchronously on invalid header values; never let a
		// notification take down the caller's update cycle.
		logger.error(`[NTFY] push rejected: ${err.message}`);
	}
}
import { Elysia } from "elysia";
import path from "node:path";
import config from "./config";
import { api } from "./routes/api";
import { partials } from "./routes/partials";
import { startScheduler } from "./scheduler";
import logger from "./logger";

const PORT = config.port;
const PUBLIC_DIR = path.join(import.meta.dir, "../frontend/public");

const app = new Elysia()
	.use(api)
	.use(partials)
	// htmx partial fragments served straight from handlers? No — single-file frontend.
	// Static catch-all LAST, API under /api/* so it never reaches this.
	.get("*", async ({ params }) => {
		const rel = params["*"] || "index.html";
		// traversal guard
		const candidate = path.join(PUBLIC_DIR, rel);
		if (!candidate.startsWith(PUBLIC_DIR + path.sep) && candidate !== path.join(PUBLIC_DIR, "index.html")) return new Response(null, { status: 403 });
		let file = Bun.file(candidate);
		if (!(await file.exists())) file = Bun.file(path.join(PUBLIC_DIR, "index.html"));
		return new Response(file, {
			headers: { "Content-Type": mime(rel) },
		});
	});

function mime(rel) {
	if (rel.endsWith(".js")) return "text/javascript";
	if (rel.endsWith(".css")) return "text/css";
	if (rel.endsWith(".svg")) return "image/svg+xml";
	if (rel.endsWith(".ico")) return "image/x-icon";
	return "text/html; charset=utf-8";
}

const HOSTNAME = process.env.EZDYNDNS_HOST || "127.0.0.1";

app.listen({ port: PORT, hostname: HOSTNAME }, () => {
	logger.info(`ezdyndns listening on ${HOSTNAME}:${PORT}`);
});

startScheduler();

process.on("SIGTERM", () => {
	logger.info("shutting down");
	app.stop();
	process.exit(0);
});
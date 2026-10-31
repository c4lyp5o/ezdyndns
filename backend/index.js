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
	// Static catch-all LAST, API under /api/* so it never reaches this.
	.get("*", async ({ params, headers }) => {
		const rel = params["*"] || "index.html";
		// traversal guard
		const candidate = path.join(PUBLIC_DIR, rel);
		if (!candidate.startsWith(PUBLIC_DIR + path.sep) && candidate !== path.join(PUBLIC_DIR, "index.html")) return new Response(null, { status: 403 });
		let file = Bun.file(candidate);
		let type = mime(rel);
		if (!(await file.exists())) {
			file = Bun.file(path.join(PUBLIC_DIR, "index.html"));
			type = mime("index.html");
		}
		// Scripts are gzipped once and cached in memory: the vendored three.js
		// is ~540 KB raw, ~130 KB compressed, and nothing in front compresses it.
		if (type === "text/javascript" && /\bgzip\b/.test(headers["accept-encoding"] ?? "")) {
			return new Response(await gzipped(file), {
				headers: { "Content-Type": type, "Content-Encoding": "gzip", Vary: "Accept-Encoding" },
			});
		}
		return new Response(file, { headers: { "Content-Type": type } });
	});

const gzipCache = new Map();
async function gzipped(file) {
	const key = `${file.name}:${file.lastModified}`;
	if (!gzipCache.has(key)) gzipCache.set(key, Bun.gzipSync(new Uint8Array(await file.arrayBuffer())));
	return gzipCache.get(key);
}

function mime(rel) {
	if (rel.endsWith(".js") || rel.endsWith(".mjs")) return "text/javascript";
	if (rel.endsWith(".woff2")) return "font/woff2";
	if (rel.endsWith(".json")) return "application/json";
	if (rel.endsWith(".txt")) return "text/plain; charset=utf-8";
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
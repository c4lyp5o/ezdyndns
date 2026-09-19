import { Elysia } from "elysia";
import {
	getServices,
	getService,
	addDomain,
	createService,
	deleteDomain,
	deleteService,
	setStatus,
	recentUpdates,
	getState,
	sanitizeService,
} from "../db";
import { restartScheduler, checkOnce } from "../scheduler";
import config from "../config";

const esc = (s) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	})[c]);

const okBadge = (ok) =>
	`<span class="badge ${ok === 1 ? "ok" : "err"}">${ok === 1 ? "ok" : "failed"}</span>`;

// seconds → human interval label
const intervalLabel = (sec) => {
	const mins = Math.round(sec / 60);
	return mins < 1 ? `${sec}s` : `${mins} min`;
};
function localTime(utc) {
	if (!utc) return "never";
	// "2026-09-19 09:47:32" (UTC) → Date
	const d = new Date(`${utc.replace(" ", "T")}Z`);
	if (Number.isNaN(d.getTime())) return esc(utc);
	return d.toLocaleString(undefined, {
		month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
	});
}

function statusPartial() {
	const ip = getState("last_ip")?.value;
	const last = getState("last_check")?.value;
	const lastLocal = last ? new Date(last).toLocaleString(undefined, {
		month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
	}) : null;
	return `
<div class="card">
	<div class="status-row">
		<span class="ip"><span class="dot"></span>${esc(ip ?? "unknown")}</span>
		<span class="last-check">last checked: ${esc(lastLocal ?? "never")}</span>
		<span class="spacer"></span>
		<button class="ghost" hx-post="/partials/check" hx-target="#status" hx-swap="innerHTML">Check now</button>
	</div>
</div>`;
}

function servicesPartial() {
	const services = getServices().map(sanitizeService);
	if (services.length === 0)
		return `<div class="muted">No services yet. Add one below.</div>`;
	return services
		.map(
			(s) => `
<table>
	<tr>
		<td><strong>${esc(s.name)}</strong> <span class="muted">${esc(s.provider)}</span></td>
		<td>
			<div class="row">
				<span class="badge ${s.status === "active" ? "ok" : "paused"}">${esc(s.status)}</span>
				<span class="muted">every ${esc(intervalLabel(s.interval_sec))}</span>
			</div>
		</td>
		<td>
			<div class="actions">
				<button class="ghost" hx-post="/partials/services/${s.id}/${s.status === "active" ? "pause" : "resume"}"
				        hx-target="#services" hx-swap="innerHTML">
					${s.status === "active" ? "Pause" : "Resume"}
				</button>
				<button class="danger" hx-delete="/partials/services/${s.id}"
				        hx-confirm="Delete service ${esc(s.name)} and all its domains?"
				        hx-target="#services" hx-swap="innerHTML">Delete</button>
			</div>
		</td>
	</tr>
	${s.domains
		.map(
			(d) => `
	<tr class="domains-row">
		<td class="muted" style="padding-left:2rem">↳ <code>${esc(d.hostname)}.${esc(d.domainname)}</code></td>
		<td></td>
		<td>
			<div class="actions">
				<button class="danger" hx-delete="/partials/services/${s.id}/domains/${d.id}"
				        hx-target="#services" hx-swap="innerHTML">Remove</button>
			</div>
		</td>
	</tr>`,
		)
		.join("")}
	<tr class="add-domain-form">
		<td style="border:none;padding-left:2rem">
			<form class="add-domain-form" hx-post="/partials/services/${s.id}/domains" hx-target="#services" hx-swap="innerHTML">
				<input name="hostname" placeholder="hostname" required style="max-width:8rem">
				<input name="domainname" placeholder="domain" required style="max-width:12rem">
				<input name="password" type="password" placeholder="ddns key" style="max-width:9rem" title="namecheap per-domain DDNS key">
				<button class="ghost">Add domain</button>
			</form>
		</td>
		<td colspan="2" style="border:none"></td>
	</tr>
</table>`,
		)
		.join("");
}

function updatesPartial() {
	const rows = recentUpdates(15);
	if (rows.length === 0) return `<div class="muted">No updates logged yet.</div>`;
	return `<div class="log-scroll">
<table>
	<tr><th>when</th><th>service</th><th>domain</th><th>ip</th><th>status</th></tr>
	${rows
		.map(
			(u) => `
	<tr>
		<td class="muted">${esc(localTime(u.created_at))}</td>
		<td>${esc(u.service_name)}</td>
		<td><code>${esc(u.hostname)}.${esc(u.domainname)}</code></td>
		<td><code>${esc(u.new_ip)}</code>${u.old_ip ? ` <span class="muted">(was ${esc(u.old_ip)})</span>` : ""}</td>
		<td>${okBadge(u.ok)} ${u.ok ? "" : `<span class="muted">${esc(u.detail ?? "")}</span>`}</td>
	</tr>`,
		)
		.join("")}
</table></div>`;
}

export const partials = new Elysia({ prefix: "/partials" })
	.onBeforeHandle(({ headers, set }) => {
		if (headers["x-api-token"] !== config.apiToken) {
			set.status = 401;
			return "unauthorized";
		}
	})
	// mutations go through here so htmx gets HTML fragments back
	.post("/check", async () => {
		await checkOnce();
		return statusPartial();
	})
	.get("/status", () => statusPartial())
	.get("/services", () => servicesPartial())
	.post("/services", ({ body }) => {
		const id = createService(body);
		if (body.hostname && body.domainname)
			addDomain(id, { hostname: body.hostname, domainname: body.domainname, password: body.dpassword });
		restartScheduler();
		return servicesPartial();
	})
	.delete("/services/:id", ({ params }) => {
		deleteService(Number(params.id));
		restartScheduler();
		return servicesPartial();
	})
	.post("/services/:id/pause", ({ params }) => {
		setStatus(Number(params.id), "paused");
		restartScheduler();
		return servicesPartial();
	})
	.post("/services/:id/resume", ({ params }) => {
		setStatus(Number(params.id), "active");
		restartScheduler();
		return servicesPartial();
	})
	.post("/services/:id/domains", ({ params, body }) => {
		addDomain(Number(params.id), body);
		return servicesPartial();
	})
	.delete("/services/:id/domains/:domainId", ({ params }) => {
		deleteDomain(Number(params.id), Number(params.domainId));
		return servicesPartial();
	})
	.get("/updates", () => updatesPartial());
import { Elysia } from "elysia";
import {
	getServices,
	getService,
	getDomains,
	addDomain,
	createService,
	updateService,
	deleteDomain,
	deleteService,
	setStatus,
	recentUpdates,
	countUpdates,
	getState,
	sanitizeService,
	domainHealth,
	recentIpChanges,
} from "../db";
import { restartScheduler, checkOnce } from "../scheduler";
import { CATALOG, PROVIDERS, verifyProvider, verifyCredentialChange } from "../services/providers";
import { formCatalog } from "../services/catalog";
import { validateRecord, validateServiceEdit } from "./api";
import config from "../config";

const esc = (s) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	})[c]);

// SQLite datetime('now') is UTC without a zone ("2026-10-31 13:04:12").
const isoUtc = (sqlTs) => (sqlTs ? `${sqlTs.replace(" ", "T")}Z` : null);

// Times render as UTC text and are rewritten to the browser's zone by ui.js
// (data-local="date|time|datetime"); data-rel renders "4 min ago".
const timeEl = (iso, mode = "datetime") =>
	iso
		? `<time class="mono" datetime="${esc(iso)}" data-local="${mode}">${esc(iso.slice(mode === "time" ? 11 : 0, mode === "date" ? 10 : 19).replace("T", " "))}</time>`
		: `<span class="dash">—</span>`;
const relEl = (iso) =>
	iso ? `<time datetime="${esc(iso)}" data-rel>${esc(iso.slice(0, 16).replace("T", " "))}</time>` : `<span class="dash">—</span>`;

const fqdnOf = (d) => (d.hostname === "@" ? d.domainname : `${d.hostname}.${d.domainname}`);

const intervalLabel = (sec) => {
	const mins = Math.round(sec / 60);
	return mins < 1 ? `${sec} s` : `${mins} min`;
};

const PROVIDER_LABEL = Object.fromEntries(Object.entries(CATALOG).map(([id, p]) => [id, p.label]));
const INTERVALS = [60, 120, 300, 600, 900, 1800];

// What a record's last pushes say about it right now.
function recordState(d, ip) {
	if (d.service_status !== "active") return { key: "paused", label: "Paused" };
	if (!d.last) return { key: "new", label: "Waiting" };
	if (d.last.ok !== 1) return { key: "failing", label: "Failing" };
	if (ip && d.last.new_ip !== ip) return { key: "pending", label: "Behind" };
	return { key: "current", label: "Current" };
}

const pill = (state) => `<span class="pill pill-${state.key}">${esc(state.label)}</span>`;

function durationLabel(ms) {
	const min = Math.floor(ms / 60000);
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	if (h < 48) return `${h} h ${min % 60} min`;
	return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// ---------- title-row finding ----------
function summaryPartial() {
	const ip = getState("last_ip")?.value;
	const records = domainHealth(1);
	if (getServices().length === 0)
		return `No services yet. Add one and ezdyndns will start pushing ${ip ? `<span class="mono">${esc(ip)}</span>` : "your public IP"} to it.`;
	if (records.length === 0) return "Your services have no records yet. Edit a service to add one.";
	const states = records.map((d) => ({ d, s: recordState(d, ip) }));
	const failing = states.filter((x) => x.s.key === "failing");
	const behind = states.filter((x) => x.s.key === "pending");
	const current = states.filter((x) => x.s.key === "current");
	if (failing.length) {
		const first = failing[0].d;
		const more = failing.length > 1 ? ` and ${failing.length - 1} more` : "";
		return `<span class="sig sig-failing" aria-hidden="true"></span>${failing.length} of ${records.length} records failing: <span class="mono">${esc(fqdnOf(first))}</span>${more}. ${esc(firstReason(first.last?.detail))}`;
	}
	if (behind.length)
		return `${behind.length} of ${records.length} records still on an older IP. The next push sends <span class="mono">${esc(ip)}</span>.`;
	if (current.length === records.length)
		return `All ${records.length} records point at <span class="mono">${esc(ip ?? "—")}</span>.`;
	return `${current.length} of ${records.length} records point at <span class="mono">${esc(ip ?? "—")}</span>; the rest are paused or waiting for their first push.`;
}

const firstReason = (detail) => {
	const d = String(detail ?? "").split("|")[0].trim();
	return d ? `${d.charAt(0).toUpperCase()}${d.slice(1, 90)}.` : "";
};

// ---------- public IP panel ----------
function heroPartial() {
	const ip = getState("last_ip")?.value;
	const source = getState("last_source")?.value;
	const last = getState("last_check")?.value;
	const next = getState("next_check")?.value;
	const changes = recentIpChanges(6);
	const since = changes[0] && changes[0].ip === ip ? isoUtc(changes[0].created_at) : null;
	const held = since ? durationLabel(Date.now() - new Date(since).getTime()) : null;

	const rows = changes
		.map((c, i) => {
			const start = new Date(isoUtc(c.created_at)).getTime();
			const end = i === 0 ? Date.now() : new Date(isoUtc(changes[i - 1].created_at)).getTime();
			return `<tr>
				<td>${timeEl(isoUtc(c.created_at))}</td>
				<td class="mono">${esc(c.ip)}</td>
				<td class="num">${i === 0 ? `<span class="muted">now · </span>` : ""}${esc(durationLabel(end - start))}</td>
			</tr>`;
		})
		.join("");

	return `
<div class="panel-head">
	<h2 class="panel-title">Public IP</h2>
	<span class="fresh"><span class="sig sig-${last ? "live" : "idle"}" aria-hidden="true"></span>checked ${relEl(last)}${next ? ` · next in <span class="mono" data-countdown="${esc(next)}">—</span>` : ""}</span>
</div>
<div class="ip-block">
	<div class="ip-value mono" data-ip="${esc(ip ?? "")}">${esc(ip ?? "—")}</div>
	<p class="ip-meta">${source ? `Seen by ${esc(source)}` : "Not checked yet"}${held ? ` · held for ${esc(held)}` : ""}</p>
</div>
<h3 class="sub-title">Address history</h3>
${
	changes.length
		? `<table class="data compact"><thead><tr><th>Seen from</th><th>Address</th><th class="num">Held</th></tr></thead><tbody>${rows}</tbody></table>`
		: `<p class="empty">No address changes recorded yet. The first check records a baseline.</p>`
}`;
}

// ---------- topology (no-JS fallback SVG + data for the 3D view) ----------
function topologyPartial() {
	const ip = getState("last_ip")?.value;
	const records = domainHealth(1);
	const data = {
		ip: ip ?? null,
		check: getState("last_check")?.value ?? null,
		records: records.map((d) => ({ id: d.id, fqdn: fqdnOf(d), state: recordState(d, ip).key })),
	};
	const W = 640;
	const H = 300;
	const cx = W / 2;
	const cy = H / 2;
	const r = 110;
	const nodes = data.records
		.map((rec, i) => {
			const a = (i / Math.max(data.records.length, 1)) * Math.PI * 2 - Math.PI / 2;
			const x = cx + Math.cos(a) * r * 1.9;
			const y = cy + Math.sin(a) * r;
			const anchor = Math.cos(a) > 0.2 ? "start" : Math.cos(a) < -0.2 ? "end" : "middle";
			const dx = anchor === "start" ? 12 : anchor === "end" ? -12 : 0;
			const dy = anchor === "middle" ? (Math.sin(a) > 0 ? 20 : -12) : 4;
			return `<line class="link link-${rec.state}" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>
<circle class="node node-${rec.state}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5"/>
<text class="node-label" x="${(x + dx).toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}">${esc(rec.fqdn)}</text>`;
		})
		.join("");
	return `<div class="topo-fallback">
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Your public IP linked to ${data.records.length} DNS records">
	${nodes}
	<circle class="home" cx="${cx}" cy="${cy}" r="9"/>
	<text class="home-label" x="${cx}" y="${cy + 28}" text-anchor="middle">${esc(ip ?? "—")}</text>
</svg></div>
<script type="application/json" class="topo-json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

// ---------- records ----------
function domainsPartial() {
	const ip = getState("last_ip")?.value;
	const records = domainHealth(24);
	if (records.length === 0)
		return `<p class="empty">No records yet. Add a service, or edit one to add a record.</p>`;
	const rows = records
		.map((d) => {
			const s = recordState(d, ip);
			const ticks = Array.from({ length: 24 }, (_, i) => d.recent[23 - i])
				.map((u) =>
					u
						? `<i class="${u.ok === 1 ? "ok" : "fail"}" title="${esc(`${u.created_at} UTC · ${u.ok === 1 ? "ok" : "failed"}`)}"></i>`
						: `<i class="none"></i>`,
				)
				.join("");
			const okCount = d.recent.filter((u) => u.ok === 1).length;
			const failNote =
				s.key === "failing"
					? `<div class="row-note">${esc(firstReason(d.last?.detail))} ${d.fail_streak > 1 ? `${d.fail_streak} in a row.` : ""}</div>`
					: "";
			return `<tr class="state-${s.key}">
	<td class="ident"><span class="mono">${esc(fqdnOf(d))}</span><span class="row-sub">${esc(d.service_name)} · ${esc(PROVIDER_LABEL[d.provider] ?? d.provider)}</span>${failNote}</td>
	<td>${pill(s)}</td>
	<td class="mono">${d.last?.new_ip ? esc(d.last.new_ip) : `<span class="dash">—</span>`}</td>
	<td>${relEl(isoUtc(d.last_ok?.created_at))}</td>
	<td><span class="ticks" role="img" aria-label="${okCount} of ${d.recent.length} recent pushes succeeded">${ticks}</span></td>
	<td class="act"><button type="button" class="text-btn" data-log-domain="${d.id}">Log</button></td>
</tr>`;
		})
		.join("");
	return `<table class="data records">
<thead><tr><th>Record</th><th>State</th><th>Points at</th><th>Last good push</th><th>Last 24 pushes</th><th><span class="sr">Actions</span></th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

// ---------- services ----------
function servicesPartial() {
	const services = getServices().map(sanitizeService);
	if (services.length === 0)
		return `<p class="empty">No services yet. <button type="button" class="text-btn" hx-get="/partials/services/new" hx-target="#dialog-body">Add a service</button></p>`;
	return `<ul class="svc-list">${services
		.map(
			(s) => `
<li>
	<div class="svc-main">
		<span class="svc-name">${esc(s.name)}</span>
		<span class="svc-meta">${esc(PROVIDER_LABEL[s.provider] ?? s.provider)} · every ${esc(intervalLabel(s.interval_sec))} · ${s.domains.length} ${s.domains.length === 1 ? "record" : "records"}</span>
	</div>
	${s.status === "active" ? `<span class="pill pill-current">Active</span>` : `<span class="pill pill-paused">Paused</span>`}
	<div class="svc-actions">
		<button type="button" class="text-btn" hx-post="/partials/services/${s.id}/${s.status === "active" ? "pause" : "resume"}" hx-target="#services">${s.status === "active" ? "Pause" : "Resume"}</button>
		<button type="button" class="ghost" hx-get="/partials/services/${s.id}/edit" hx-target="#dialog-body">Edit</button>
	</div>
</li>`,
		)
		.join("")}</ul>`;
}

// ---------- push log ----------
function updatesPartial(query = {}) {
	const filter = { domainId: query.domain_id || null, failedOnly: query.result === "failed" };
	const rows = recentUpdates(Math.min(Math.max(Number(query.limit) || 50, 1), 200), filter);
	const total = countUpdates(filter);
	const count = `<p class="log-count">${total === 0 ? "No pushes" : `Showing ${rows.length.toLocaleString("en")} of ${total.toLocaleString("en")} ${total === 1 ? "push" : "pushes"}`}</p>`;
	if (rows.length === 0)
		return `${count}<p class="empty">${filter.failedOnly ? "No failed pushes in the log. Failures are kept for 30 days." : "No pushes logged yet."}</p>`;
	return `${count}<div class="log-frame"><table class="data log">
<thead><tr><th>Time</th><th>Record</th><th>Address</th><th>Result</th><th>Detail</th></tr></thead>
<tbody>${rows
		.map(
			(u) => `
<tr data-id="${u.id}" class="${u.ok === 1 ? "" : "is-fail"}">
	<td>${timeEl(isoUtc(u.created_at))}</td>
	<td class="mono">${esc(u.hostname === "@" ? u.domainname : `${u.hostname}.${u.domainname}`)}</td>
	<td class="mono">${esc(u.new_ip)}${u.old_ip && u.old_ip !== u.new_ip ? ` <span class="faint">from ${esc(u.old_ip)}</span>` : ""}</td>
	<td>${u.ok === 1 ? `<span class="pill pill-current">ok</span>` : `<span class="pill pill-failing">failed</span>`}</td>
	<td class="detail">${esc(u.detail ?? "")}</td>
</tr>`,
		)
		.join("")}</tbody></table></div>`;
}

// ---------- dialogs ----------
const intervalOptions = (selected) =>
	INTERVALS.map((s) => `<option value="${s}"${s === selected ? " selected" : ""}>${intervalLabel(s)}</option>`).join("");

function newServicePartial() {
	const providerOpts = PROVIDERS.map((p) => `<option value="${p}">${esc(PROVIDER_LABEL[p] ?? p)}</option>`).join("");
	return `
<form class="sheet" hx-post="/partials/services" hx-disable="find button[type=submit]" data-close-on-success data-provider-form data-catalog="${esc(JSON.stringify(formCatalog()))}">
	<header class="sheet-head"><h2>Add service</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
	<div class="field-grid">
		<label class="field"><span>Provider</span><select name="provider" data-provider>${providerOpts}</select></label>
		<label class="field"><span>Name</span><input name="name" required placeholder="home-namecheap" autocomplete="off"></label>
		<label class="field" data-cred="username"><span data-cred-label>API token</span><input name="username" type="password" autocomplete="off"></label>
		<label class="field" data-cred="password"><span data-cred-label>Dynamic DNS password</span><input name="password" type="password" autocomplete="off"></label>
		<label class="field"><span>Check every</span><select name="interval_sec">${intervalOptions(300)}</select></label>
	</div>
	<p class="hint" data-cred-hint></p>
	<h3 class="sub-title">First record</h3>
	<div class="field-grid">
		<label class="field"><span>Host</span><input name="hostname" placeholder="home or @" autocomplete="off"></label>
		<label class="field"><span>Domain</span><input name="domainname" placeholder="domain.tld" autocomplete="off" data-domain></label>
	</div>
	<p class="form-result" data-result role="status" aria-live="polite"></p>
	<footer class="sheet-foot"><button type="button" class="ghost" data-close>Cancel</button><button type="submit" class="primary">Verify and add</button></footer>
</form>`;
}

function editServicePartial(id) {
	const s = getService(id);
	if (!s) return `<p class="empty">That service no longer exists.</p>`;
	const meta = CATALOG[s.provider] ?? CATALOG.namecheap;
	const records = getDomains(id);
	const credFields = meta.fields
		.map(
			(f) =>
				`<label class="field"><span>${esc(f.edit)}</span><input name="${f.name}" type="password" autocomplete="off" placeholder="Leave blank to keep the current one"></label>`,
		)
		.join("");
	const perRecord = meta.perRecord
		? `<label class="field"><span>${esc(meta.perRecord.label)}</span><input name="password" type="password" autocomplete="off" ${meta.perRecord.required && records.length > 0 ? "required" : `placeholder="Optional"`}></label>`
		: "";
	const recordRows = records
		.map(
			(d) => `<li><span class="mono">${esc(fqdnOf(d))}</span>
	<button type="button" class="text-btn danger" hx-delete="/partials/services/${id}/domains/${d.id}" hx-target="#dialog-body" hx-confirm="Remove ${esc(fqdnOf(d))} from ${esc(s.name)}? ezdyndns stops updating it; the DNS record itself is left as it is.">Remove</button></li>`,
		)
		.join("");
	return `
<div class="sheet">
	<header class="sheet-head"><h2>${esc(s.name)}</h2><span class="pill pill-neutral">${esc(PROVIDER_LABEL[s.provider] ?? s.provider)}</span><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
	<form hx-patch="/partials/services/${id}" hx-disable="find button[type=submit]" data-close-on-success>
		<div class="field-grid">
			<label class="field"><span>Name</span><input name="name" value="${esc(s.name)}" required autocomplete="off"></label>
			<label class="field"><span>Check every</span><select name="interval_sec">${intervalOptions(s.interval_sec)}</select></label>
			${credFields}
			<fieldset class="field"><legend>Updates</legend>
				<div class="seg">
					<label><input type="radio" name="status" value="active"${s.status === "active" ? " checked" : ""}><span>Active</span></label>
					<label><input type="radio" name="status" value="paused"${s.status === "paused" ? " checked" : ""}><span>Paused</span></label>
				</div>
			</fieldset>
		</div>
		<p class="hint">${esc(meta.editHint)}</p>
		<p class="form-result" data-result role="status" aria-live="polite"></p>
		<footer class="sheet-foot"><button type="submit" class="primary">Save changes</button></footer>
	</form>

	<section class="sheet-section">
		<h3 class="sub-title">Records</h3>
		${records.length ? `<ul class="rec-list">${recordRows}</ul>` : `<p class="empty">No records. Add one below.</p>`}
		<form class="add-record" hx-post="/partials/services/${id}/domains" hx-target="#dialog-body">
			<label class="field"><span>Host</span><input name="hostname" required placeholder="home or @" autocomplete="off"></label>
			<label class="field"><span>Domain</span><input name="domainname" required ${meta.domain ? `value="${esc(meta.domain)}"` : `placeholder="domain.tld"`} autocomplete="off"></label>
			${perRecord}
			<button type="submit" class="ghost">Add record</button>
			<p class="form-result" data-result role="status" aria-live="polite"></p>
		</form>
	</section>

	<section class="sheet-section danger-zone">
		<h3 class="sub-title">Delete service</h3>
		<p class="hint">Stops all updates for ${records.length} ${records.length === 1 ? "record" : "records"} and deletes their push history. DNS records at ${esc(PROVIDER_LABEL[s.provider] ?? s.provider)} are left as they are.</p>
		<button type="button" class="ghost danger" hx-delete="/partials/services/${id}" hx-confirm="Delete ${esc(s.name)} and its ${records.length} ${records.length === 1 ? "record" : "records"}?" data-close-on-success>Delete ${esc(s.name)}</button>
	</section>
</div>`;
}

const conflict = (set, err) => {
	if (String(err?.message).includes("UNIQUE")) {
		set.status = 409;
		return { message: "A service or record with that name already exists." };
	}
	throw err;
};

export const partials = new Elysia({ prefix: "/partials" })
	.onBeforeHandle(({ headers, set }) => {
		if (headers["x-api-token"] !== config.apiToken) {
			set.status = 401;
			return "unauthorized";
		}
	})
	.post("/check", async () => {
		await checkOnce();
		return heroPartial();
	})
	.get("/summary", () => summaryPartial())
	.get("/hero", () => heroPartial())
	.get("/topology", () => topologyPartial())
	.get("/domains", () => domainsPartial())
	.get("/services", () => servicesPartial())
	.get("/updates", ({ query }) => updatesPartial(query))
	.get("/services/new", () => newServicePartial())
	.get("/services/:id/edit", ({ params }) => editServicePartial(Number(params.id)))
	// Dialog mutations answer 204 (htmx 4 does not swap it); the client closes
	// the dialog and refreshes every panel. Failures answer JSON { message }.
	.post("/services", async ({ body, set }) => {
		// Same credential gate as POST /api/services — a bad deSEC/CF token is
		// rejected before it can sit failing silently in the update log.
		const check = await verifyProvider({
			provider: body.provider,
			username: body.username,
			password: body.password,
			hostname: body.hostname,
			domainname: body.domainname,
		});
		if (!check.ok) {
			set.status = 422;
			return { message: `Credential check failed: ${check.detail}` };
		}
		try {
			const id = createService(body);
			if (body.hostname && body.domainname)
				addDomain(id, { hostname: body.hostname, domainname: body.domainname });
		} catch (err) {
			return conflict(set, err);
		}
		restartScheduler();
		set.status = 204;
	})
	.patch("/services/:id", async ({ params, body, set }) => {
		const id = Number(params.id);
		const service = getService(id);
		if (!service) {
			set.status = 404;
			return { message: "That service no longer exists." };
		}
		const problem = validateServiceEdit(body ?? {});
		if (problem) {
			set.status = 400;
			return { message: problem };
		}
		const check = await verifyCredentialChange(service, getDomains(id)[0], body);
		if (check && !check.ok) {
			set.status = 422;
			return { message: `Credential check failed: ${check.detail}` };
		}
		try {
			updateService(id, body);
		} catch (err) {
			return conflict(set, err);
		}
		restartScheduler();
		set.status = 204;
	})
	.delete("/services/:id", ({ params, set }) => {
		deleteService(Number(params.id));
		restartScheduler();
		set.status = 204;
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
	.post("/services/:id/domains", ({ params, body, set }) => {
		const id = Number(params.id);
		if (!getService(id)) {
			set.status = 404;
			return { message: "That service no longer exists." };
		}
		const problem = validateRecord(getService(id), body ?? {}, getDomains(id).length);
		if (problem) {
			set.status = 400;
			return { message: problem };
		}
		try {
			addDomain(id, body);
		} catch (err) {
			return conflict(set, err);
		}
		return editServicePartial(id);
	})
	.delete("/services/:id/domains/:domainId", ({ params }) => {
		deleteDomain(Number(params.id), Number(params.domainId));
		return editServicePartial(Number(params.id));
	});

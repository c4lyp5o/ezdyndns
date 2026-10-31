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
	getDomain,
	updateDomain,
	serviceOptions,
} from "../db";
import { isIP } from "node:net";
import { restartScheduler, checkOnce, pushDomainNow, pushServiceSoon } from "../scheduler";
import { CATALOG, PROVIDERS, verifyProvider, verifyCredentialChange } from "../services/providers";
import { formCatalog } from "../services/catalog";
import { cleanName, lookup, mailReport, reverseReport } from "../services/dnstools";
import { mergedSettings, pushDomainSoon, settingsFrom, toolQuery, validateRecord, validateServiceEdit } from "./api";
import config from "../config";
import { esc } from "./html";
import { lookupResult, mailResult, reverseResult, toolError } from "./toolbox";


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
function recordState(d, ip, ip6 = getState("last_ip6")?.value) {
	if (d.service_status !== "active") return { key: "paused", label: "Paused" };
	if (d.held && d.hold_kind === "hard") return { key: "held", label: "Needs attention" };
	if (!d.last) return { key: "new", label: "Waiting" };
	if (d.held) return { key: "waiting", label: "Backing off" };
	if (d.last.ok !== 1) return { key: "failing", label: "Failing" };
	const want = d.record_type === "AAAA" ? ip6 : ip;
	if (want && d.last.new_ip !== want) return { key: "pending", label: "Behind" };
	return { key: "current", label: "Current" };
}

// The record's name, with its type when it isn't a plain A record.
const recordName = (d) =>
	`<span class="rec-name"><span class="mono">${esc(fqdnOf(d))}</span>${d.record_type === "AAAA" ? ` <span class="type-tag">AAAA</span>` : ""}</span>`;

const DNS_VERDICT = {
	resolves: { cls: "current", label: "Resolves" },
	propagating: { cls: "pending", label: "Propagating" },
	mismatch: { cls: "failing", label: "Mismatch" },
	unknown: { cls: "neutral", label: "Unknown" },
};

// What the resolvers last said about a record, as a pill with the answers in its title.
function dnsCell(d) {
	if (!d.dns_verdict) return `<span class="dash" title="Not checked yet">—</span>`;
	const v = DNS_VERDICT[d.dns_verdict] ?? DNS_VERDICT.unknown;
	let answers = [];
	try {
		answers = JSON.parse(d.dns_results ?? "[]");
	} catch {}
	const title = [
		`Expected ${d.dns_expected ?? "—"}`,
		...answers.map((r) => `${r.kind === "authoritative" ? "auth " : ""}${r.server}: ${r.error ?? (r.values.join(", ") || r.empty || "none")}`),
		`Checked ${d.dns_checked_at} UTC`,
	].join("\n");
	return `<button type="button" class="pill pill-${v.cls} pill-btn" title="${esc(title)}" data-tool-lookup="${esc(fqdnOf(d))}" data-tool-type="${esc(d.record_type ?? "A")}" data-tool-expected="${esc(d.dns_expected ?? "")}">${esc(v.label)}</button>`;
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
	const failing = states.filter((x) => x.s.key === "failing" || x.s.key === "held");
	const behind = states.filter((x) => x.s.key === "pending");
	const current = states.filter((x) => x.s.key === "current");
	if (failing.length) {
		const first = failing[0].d;
		const more = failing.length > 1 ? ` and ${failing.length - 1} more` : "";
		const held = failing.filter((x) => x.s.key === "held").length;
		return `<span class="sig sig-failing" aria-hidden="true"></span>${failing.length} of ${records.length} records failing${held ? ` (${held} paused until you fix ${held === 1 ? "it" : "them"})` : ""}: <span class="mono">${esc(fqdnOf(first))}</span>${more}. ${esc(firstReason(first.hold_reason ?? first.last?.detail))}`;
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
	<p class="ip-meta">${source ? `Agreed by ${esc(source.replaceAll("+", ", "))}` : "Not checked yet"}${held ? ` · held for ${esc(held)}` : ""}</p>
	${getState("last_ip6")?.value ? `<p class="ip-meta">IPv6 <span class="mono">${esc(getState("last_ip6").value)}</span></p>` : ""}
	${getState("last_check_error")?.value ? `<p class="row-note">Last check pushed nothing: ${esc(getState("last_check_error").value)}</p>` : ""}
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
function domainsPartial(flash = null) {
	const ip = getState("last_ip")?.value;
	const records = domainHealth(24);
	if (records.length === 0)
		return `<p class="empty">No records yet. Add a service, or edit one to add a record.</p>`;
	const rows = records
		.map((d) => {
			const s = recordState(d, ip);
			const TICK = { 0: ["fail", "failed"], 1: ["ok", "ok"], 2: ["skip", "skipped"] };
			const ticks = Array.from({ length: 24 }, (_, i) => d.recent[23 - i])
				.map((u) =>
					u
						? `<i class="${TICK[u.ok][0]}" title="${esc(`${u.created_at} UTC · ${TICK[u.ok][1]}${u.ok === 2 ? ` · ${u.detail ?? ""}` : ""}`)}"></i>`
						: `<i class="none"></i>`,
				)
				.join("");
			const okCount = d.recent.filter((u) => u.ok === 1).length;
			let note = "";
			if (s.key === "held")
				note = `<div class="row-note">${esc(firstReason(d.hold_reason))} Fix it, then press Retry.</div>`;
			else if (s.key === "waiting")
				note = `<div class="row-note">${esc(firstReason(d.hold_reason))} Next try after ${timeEl(isoUtc(d.hold_until), "time")}.</div>`;
			else if (s.key === "failing")
				note = `<div class="row-note">${esc(firstReason(d.last?.detail))} ${d.fail_streak > 1 ? `${d.fail_streak} in a row.` : ""}</div>`;
			const reply =
				flash && flash.id === d.id
					? `<div class="row-reply ${flash.ok ? "ok" : "bad"}" role="status">Pushed just now: <span class="mono">${esc(flash.detail ?? "")}</span></div>`
					: "";
			const pushLabel = d.held ? "Retry" : "Push";
			return `<tr class="state-${s.key}">
	<td class="ident">${recordName(d)}<span class="row-sub">${esc(d.service_name)} · ${esc(PROVIDER_LABEL[d.provider] ?? d.provider)} · last good ${relEl(isoUtc(d.last_ok?.created_at))}</span>${note}${reply}</td>
	<td>${pill(s)}</td>
	<td class="mono">${d.last?.new_ip ? esc(d.last.new_ip) : `<span class="dash">—</span>`}</td>
	<td>${dnsCell(d)}</td>
	<td><span class="ticks" role="img" aria-label="${okCount} of ${d.recent.filter((u) => u.ok !== 2).length} recent pushes succeeded">${ticks}</span></td>
	<td class="act">${d.service_status === "active" ? `<button type="button" class="text-btn" hx-post="/partials/domains/${d.id}/push" hx-target="#domains" hx-disable="this" data-no-refresh title="Push this record now and show the provider's reply">${pushLabel}</button>` : ""}<button type="button" class="text-btn" data-log-domain="${d.id}">Log</button></td>
</tr>`;
		})
		.join("");
	return `<table class="data records">
<thead><tr><th>Record</th><th>State</th><th>Points at</th><th title="What the zone's nameservers and public resolvers answer">DNS</th><th>Last 24 cycles</th><th><span class="sr">Actions</span></th></tr></thead>
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
	const filter = { domainId: query.domain_id || null, failedOnly: query.result === "failed", sentOnly: query.result === "sent" };
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
<tr data-id="${u.id}" class="${u.ok === 0 ? "is-fail" : u.ok === 2 ? "is-skip" : ""}">
	<td>${timeEl(isoUtc(u.created_at))}</td>
	<td class="mono">${esc(u.hostname === "@" ? u.domainname : `${u.hostname}.${u.domainname}`)}</td>
	<td class="mono">${esc(u.new_ip)}${u.old_ip && u.old_ip !== u.new_ip ? ` <span class="faint">from ${esc(u.old_ip)}</span>` : ""}</td>
	<td>${u.ok === 1 ? `<span class="pill pill-current">ok</span>` : u.ok === 2 ? `<span class="pill pill-neutral">skipped</span>` : `<span class="pill pill-failing">failed</span>`}</td>
	<td class="detail">${esc(u.detail ?? "")}</td>
</tr>`,
		)
		.join("")}</tbody></table></div>`;
}

// ---------- dialogs ----------
const intervalOptions = (selected) =>
	INTERVALS.map((s) => `<option value="${s}"${s === selected ? " selected" : ""}>${intervalLabel(s)}</option>`).join("");

// Every provider setting as a hidden field; app.js shows the chosen provider's.
const settingFields = () => {
	const seen = new Map();
	for (const p of Object.values(CATALOG)) for (const f of p.settings ?? []) seen.set(f.name, f);
	return [...seen.values()]
		.map(
			(f) =>
				`<label class="field" data-setting="${f.name}" hidden><span>${esc(f.label)}</span><input name="${f.name}" placeholder="${esc(f.placeholder ?? "")}" autocomplete="off" disabled></label>`,
		)
		.join("");
};

const typeOptions = (ipv6, selected = "A") =>
	["A", ...(ipv6 ? ["AAAA"] : [])]
		.map((t) => `<option value="${t}"${t === selected ? " selected" : ""}>${t === "A" ? "A (IPv4)" : "AAAA (IPv6)"}</option>`)
		.join("");

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
		${settingFields()}
		<label class="field"><span>Check every</span><select name="interval_sec">${intervalOptions(300)}</select></label>
	</div>
	<p class="hint" data-cred-hint></p>
	<h3 class="sub-title">First record</h3>
	<div class="field-grid field-grid-3">
		<label class="field"><span>Host</span><input name="hostname" placeholder="home or @" autocomplete="off"></label>
		<label class="field"><span>Domain</span><input name="domainname" placeholder="domain.tld" autocomplete="off" data-domain></label>
		<label class="field"><span>Type</span><select name="record_type" data-record-type>${typeOptions(true)}</select></label>
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
	const options = serviceOptions(s);
	const settings = (meta.settings ?? [])
		.map(
			(f) =>
				`<label class="field"><span>${esc(f.label)}</span><input name="${f.name}" value="${esc(options[f.name] ?? "")}" placeholder="${esc(f.placeholder ?? "")}" autocomplete="off"></label>`,
		)
		.join("");
	const perRecord = meta.perRecord
		? `<label class="field"><span>${esc(meta.perRecord.label)}</span><input name="password" type="password" autocomplete="off" ${meta.perRecord.required && records.length > 0 ? "required" : `placeholder="Optional"`}></label>`
		: "";
	const recordRows = records
		.map(
			(d) => `<li>
	<div class="rec-line">${recordName(d)}
		<span class="rec-actions">
			<details class="rec-edit"><summary class="text-btn">Edit</summary>
				<form class="add-record" hx-patch="/partials/services/${id}/domains/${d.id}" hx-target="#dialog-body">
					<label class="field"><span>Host</span><input name="hostname" required value="${esc(d.hostname)}" autocomplete="off"></label>
					<label class="field"><span>Domain</span><input name="domainname" required value="${esc(d.domainname)}" autocomplete="off"></label>
					${meta.ipv6 ? `<label class="field"><span>Type</span><select name="record_type">${typeOptions(true, d.record_type)}</select></label>` : ""}
					${meta.perRecord ? `<label class="field"><span>${esc(meta.perRecord.label)}</span><input name="password" type="password" autocomplete="off" placeholder="Leave blank to keep"></label>` : ""}
					<button type="submit" class="ghost">Save record</button>
					<p class="form-result" data-result role="status" aria-live="polite"></p>
				</form>
			</details>
			<button type="button" class="text-btn danger" hx-delete="/partials/services/${id}/domains/${d.id}" hx-target="#dialog-body" hx-confirm="Remove ${esc(fqdnOf(d))} from ${esc(s.name)}? ezdyndns stops updating it; the DNS record itself is left as it is.">Remove</button>
		</span>
	</div>
</li>`,
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
			${settings}
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
			${meta.ipv6 ? `<label class="field"><span>Type</span><select name="record_type">${typeOptions(true)}</select></label>` : ""}
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
	// A check that can't agree on the IP still answers with the hero, which shows why.
	.post("/check", async () => {
		await checkOnce().catch(() => {});
		return heroPartial();
	})
	.get("/summary", () => summaryPartial())
	.get("/hero", () => heroPartial())
	.get("/topology", () => topologyPartial())
	.get("/domains", () => domainsPartial())
	// Push or Retry one record; the table comes back with the provider's reply under it.
	.post("/domains/:id/push", async ({ params }) => {
		const id = Number(params.id);
		if (!getDomain(id)) return domainsPartial();
		const res = await pushDomainNow(id).catch((err) => ({ ok: false, detail: err.message }));
		return domainsPartial({ id, ok: res.ok, detail: res.detail });
	})
	// Toolbox. Errors answer 200 with a message so htmx shows them in place.
	.get("/tools/lookup", async ({ query }) => {
		const input = toolQuery(query);
		if (input.error) return toolError(input.error);
		const expected = isIP(String(query.expected ?? "")) ? query.expected : null;
		return lookupResult(await lookup(input.name, input.type), { expected });
	})
	.get("/tools/mail", async ({ query }) => {
		const domain = cleanName(query.domain);
		if (!domain) return toolError("Enter a domain name, for example example.com.");
		const selector = String(query.selector ?? "").trim();
		if (selector && !cleanName(`${selector}.x`)) return toolError("That DKIM selector isn't a valid DNS label.");
		return mailResult(await mailReport(domain, selector || null));
	})
	.get("/tools/reverse", async ({ query }) => {
		const ip = String(query.ip ?? "").trim();
		if (!isIP(ip)) return toolError("Enter an IPv4 or IPv6 address.");
		return reverseResult(await reverseReport(ip));
	})
	.get("/services", () => servicesPartial())
	.get("/updates", ({ query }) => updatesPartial(query))
	.get("/services/new", () => newServicePartial())
	.get("/services/:id/edit", ({ params }) => editServicePartial(Number(params.id)))
	// Dialog mutations answer 204 (htmx 4 does not swap it); the client closes
	// the dialog and refreshes every panel. Failures answer JSON { message }.
	.post("/services", async ({ body, set }) => {
		// Same credential gate as POST /api/services — a bad deSEC/CF token is
		// rejected before it can sit failing silently in the update log.
		const options = settingsFrom(body.provider, body);
		if (body.hostname || body.domainname) {
			const problem = validateRecord({ provider: body.provider }, body, 0);
			if (problem) {
				set.status = 400;
				return { message: problem };
			}
		}
		const check = await verifyProvider({
			provider: body.provider,
			username: body.username,
			password: body.password,
			options,
			hostname: body.hostname,
			domainname: body.domainname,
		});
		if (!check.ok) {
			set.status = 422;
			return { message: `Credential check failed: ${check.detail}` };
		}
		let id;
		try {
			id = createService({ ...body, options });
			if (body.hostname && body.domainname)
				addDomain(id, { hostname: body.hostname, domainname: body.domainname, record_type: body.record_type });
		} catch (err) {
			return conflict(set, err);
		}
		restartScheduler();
		pushServiceSoon(id);
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
			updateService(id, { ...body, options: mergedSettings(service, body) });
		} catch (err) {
			return conflict(set, err);
		}
		restartScheduler();
		if (body.status === "active" && service.status !== "active") pushServiceSoon(id);
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
		pushServiceSoon(Number(params.id));
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
			pushDomainSoon(addDomain(id, body));
		} catch (err) {
			return conflict(set, err);
		}
		return editServicePartial(id);
	})
	.patch("/services/:id/domains/:domainId", ({ params, body, set }) => {
		const service = getService(Number(params.id));
		const domain = getDomain(Number(params.domainId));
		if (!service || !domain || domain.service_id !== service.id) {
			set.status = 404;
			return { message: "That record no longer exists." };
		}
		const problem = validateRecord(service, { ...body, password: body?.password || domain.password }, 0);
		if (problem) {
			set.status = 400;
			return { message: problem };
		}
		try {
			updateDomain(service.id, domain.id, body);
		} catch (err) {
			return conflict(set, err);
		}
		pushDomainSoon(domain.id);
		return editServicePartial(service.id);
	})
	.delete("/services/:id/domains/:domainId", ({ params }) => {
		deleteDomain(Number(params.id), Number(params.domainId));
		return editServicePartial(Number(params.id));
	});

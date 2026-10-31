import { esc } from "./html";

// Server-rendered results for the dashboard's Toolbox panel. The lookups
// themselves live in services/dnstools.js and are also served as JSON under
// /api/tools/*.

const values = (r) => {
	if (r.error) return `<span class="note-bad">${esc(r.error)}</span>`;
	if (r.values.length === 0) return `<span class="faint">${esc(r.empty ?? "no answer")}</span>`;
	return r.values.map((v) => `<div class="mono val">${esc(v)}</div>`).join("");
};

const ttl = (r) => (r.ttl != null ? `<span class="mono">${esc(r.ttl)}</span>` : `<span class="dash">—</span>`);

function resolverRows(rows, kind, expected) {
	return rows
		.map((r) => {
			const match = expected && !r.error ? (r.values.includes(expected) ? "match" : "differs") : "";
			return `<tr class="${match ? `is-${match}` : ""}">
	<td><span class="tool-kind">${kind}</span> ${esc(r.server)}<span class="row-sub mono">${esc(r.ip)}</span></td>
	<td>${values(r)}</td>
	<td class="num">${ttl(r)}</td>
</tr>`;
		})
		.join("");
}

export function lookupResult(result, { expected } = {}) {
	const verdict = result.consistent
		? `<p class="tool-verdict ok">Every server gives the same answer.</p>`
		: `<p class="tool-verdict warn">Servers disagree. A recent change may still be propagating, or the zone's nameservers are out of sync.</p>`;
	const zone = result.zone
		? `<p class="hint">Authoritative for <span class="mono">${esc(result.zone)}</span>: ${result.authoritative.length} nameserver${result.authoritative.length === 1 ? "" : "s"} asked directly.</p>`
		: "";
	return `<h3 class="sub-title"><span class="mono">${esc(result.name)}</span> ${esc(result.type)}</h3>
${verdict}${zone}
<table class="data tool-table">
<thead><tr><th>Server</th><th>Answer</th><th class="num">TTL</th></tr></thead>
<tbody>${resolverRows(result.authoritative, "Auth", expected)}${resolverRows(result.public, "Public", expected)}</tbody>
</table>`;
}

const notes = (list) =>
	list.length
		? `<ul class="tool-notes">${list.map((n) => `<li class="note-${n.level}">${esc(n.text)}</li>`).join("")}</ul>`
		: "";

export function mailResult(r) {
	const mx = r.mx.length
		? `<table class="data compact"><thead><tr><th class="num">Pri</th><th>Mail server</th><th>Addresses</th></tr></thead><tbody>${r.mx
				.map(
					(m) =>
						`<tr><td class="num mono">${esc(m.priority)}</td><td class="mono">${esc(m.exchange || ".")}</td><td>${m.addresses.map((a) => `<div class="mono val">${esc(a)}</div>`).join("") || `<span class="dash">—</span>`}</td></tr>`,
				)
				.join("")}</tbody></table>`
		: "";
	const spf = r.spf
		? `<div class="mono val wrap">${esc(r.spf.record)}</div>`
		: "";
	const dmarc = r.dmarc
		? `<div class="mono val wrap">${esc(r.dmarc.record)}</div>`
		: "";
	const dkim = r.selector
		? `<section class="tool-block"><h4>DKIM <span class="mono faint">${esc(r.selector)}._domainkey</span></h4>${r.dkim ? `<div class="mono val wrap">${esc(r.dkim.record.slice(0, 160))}${r.dkim.record.length > 160 ? "…" : ""}</div>` : ""}${notes(r.dkimNotes)}</section>`
		: `<section class="tool-block"><h4>DKIM</h4><p class="hint">Add a selector (for example <span class="mono">google</span> or <span class="mono">selector1</span>) to check a key.</p></section>`;
	return `<h3 class="sub-title">Mail for <span class="mono">${esc(r.domain)}</span></h3>
<div class="tool-grid">
	<section class="tool-block"><h4>MX</h4>${mx}${notes(r.mxNotes)}</section>
	<section class="tool-block"><h4>SPF</h4>${spf}${notes(r.spfNotes)}</section>
	<section class="tool-block"><h4>DMARC</h4>${dmarc}${notes(r.dmarcNotes)}</section>
	${dkim}
</div>`;
}

export function reverseResult(r) {
	if (r.error) return `<p class="tool-verdict bad">PTR lookup for <span class="mono">${esc(r.ip)}</span> failed: ${esc(r.error)}.</p>`;
	if (r.names.length === 0)
		return `<p class="tool-verdict warn">No PTR record for <span class="mono">${esc(r.ip)}</span>. Mail servers often reject mail from addresses without one; only the address's owner (your ISP) can set it.</p>`;
	return `<h3 class="sub-title">Reverse DNS for <span class="mono">${esc(r.ip)}</span></h3>
<table class="data compact"><thead><tr><th>PTR name</th><th>Resolves to</th><th>Forward-confirmed</th></tr></thead><tbody>${r.names
		.map(
			(n) =>
				`<tr><td class="mono">${esc(n.name)}</td><td>${n.addresses.map((a) => `<div class="mono val">${esc(a)}</div>`).join("") || `<span class="dash">—</span>`}</td><td>${n.confirmed ? `<span class="pill pill-current">Yes</span>` : `<span class="pill pill-failing">No</span>`}</td></tr>`,
		)
		.join("")}</tbody></table>`;
}

export const toolError = (message) => `<p class="tool-verdict bad">${esc(message)}</p>`;

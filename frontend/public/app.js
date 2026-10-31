// ezdyndns dashboard glue — an external file because traefik's
// enhanced-security middleware sets `script-src 'self'`, which blocks inline
// <script> and inline on* handlers. Motion and the 3D view live in ui.js.
const getToken = () => sessionStorage.getItem("ezdyndns_token");
const dialog = document.getElementById("dialog");

function lock() {
	sessionStorage.removeItem("ezdyndns_token");
	document.body.classList.remove("authed");
	if (dialog.open) dialog.close();
}

// htmx 4: event is htmx:config:request, headers at evt.detail.ctx.request.headers
document.body.addEventListener("htmx:config:request", (e) => {
	const t = getToken();
	if (!t) {
		e.preventDefault(); // locked page never fires requests
		return;
	}
	e.detail.ctx.request.headers["x-api-token"] = t;
});

// htmx 4 swaps 4xx/5xx bodies by default (noSwap is only 204/304), so a failed
// poll or action would replace a panel with "unauthorized" or an error page.
// Keep the last good fragment and show the message on the form that sent it.
// A successful change refreshes every panel and closes its dialog.
document.body.addEventListener("htmx:after:request", (e) => {
	const { ctx } = e.detail;
	const status = ctx.response?.status ?? 0;
	const src = ctx.sourceElement;
	const result = src?.closest?.("form, .sheet")?.querySelector("[data-result]");
	if (status >= 400 || status === 0) {
		ctx.swap = "none";
		if (status === 401) return lock();
		if (result) {
			let msg = `Request failed (HTTP ${status || "network"}).`;
			try { msg = JSON.parse(ctx.text).message ?? msg; } catch {}
			result.textContent = msg;
		}
		return;
	}
	if (result) result.textContent = "";
	const method = (ctx.request?.method ?? "GET").toUpperCase();
	if (method === "GET") return;
	if (src?.closest?.("[data-close-on-success]") && dialog.open) dialog.close();
	htmx.trigger(document.body, "ezdyndns:refresh");
});

// ---------- auth ----------
if (getToken()) {
	document.body.classList.add("authed");
	fetch("/api/status", { headers: { "x-api-token": getToken() } })
		.then((r) => { if (!r.ok) lock(); })
		.catch(() => {}); // offline: keep the session, the panels show their own errors
}

function unlock() {
	const t = document.getElementById("api-token").value.trim();
	if (!t) return;
	const state = document.getElementById("lockstate");
	state.textContent = "Checking…";
	state.classList.remove("error");
	fetch("/api/status", { headers: { "x-api-token": t } })
		.then((r) => {
			if (r.ok) {
				sessionStorage.setItem("ezdyndns_token", t);
				location.reload(); // reload reveals .gated and fires the load triggers
			} else {
				state.textContent = "That token was not accepted.";
				state.classList.add("error");
			}
		})
		.catch(() => {
			state.textContent = "Could not reach ezdyndns. Is the server running?";
			state.classList.add("error");
		});
}

document.getElementById("unlock-btn").addEventListener("click", unlock);
document.getElementById("api-token").addEventListener("keydown", (e) => {
	if (e.key === "Enter") unlock();
});
document.getElementById("lock-btn").addEventListener("click", lock);
document.getElementById("scope").textContent = location.host;
// A phone shows the latest 12 pushes; the count line still states the total.
document.getElementById("log-limit").value = matchMedia("(max-width: 640px)").matches ? "12" : "50";

// ---------- dialog ----------
// Dialog content is fetched into #dialog-body; opening happens after the swap.
document.body.addEventListener("htmx:after:swap", (e) => {
	const target = e.detail.ctx?.target;
	if (target?.id !== "dialog-body") return;
	if (!dialog.open) dialog.showModal();
	syncProviderForm(dialog.querySelector("[data-provider-form]"));
	dialog.querySelector("input:not([type=hidden]), select")?.focus();
});
dialog.addEventListener("click", (e) => {
	if (e.target === dialog || e.target.closest("[data-close]")) dialog.close();
});

// ---------- add-service form: fields follow the provider ----------
// The server renders the provider catalog into data-catalog (backend/services/catalog.js).
function syncProviderForm(form) {
	if (!form) return;
	const catalog = JSON.parse(form.dataset.catalog);
	const cfg = catalog[form.querySelector("[data-provider]").value] ?? Object.values(catalog)[0];
	for (const field of form.querySelectorAll("[data-cred]")) {
		const spec = cfg.fields.find((f) => f.name === field.dataset.cred);
		field.hidden = !spec;
		field.querySelector("input").disabled = !spec;
		if (spec) field.querySelector("[data-cred-label]").textContent = spec.label;
	}
	form.querySelector("[data-cred-hint]").textContent = cfg.hint;
	// Duck DNS serves one zone: fill it in, and clear it again on switching away.
	const domain = form.querySelector("[data-domain]");
	if (cfg.domain) {
		domain.value = cfg.domain;
		domain.dataset.filled = "";
	} else if ("filled" in domain.dataset) {
		domain.value = "";
		delete domain.dataset.filled;
	}
}
dialog.addEventListener("change", (e) => {
	if (e.target.matches("[data-provider]")) syncProviderForm(e.target.closest("form"));
});

// ---------- record → log filter ----------
document.body.addEventListener("click", (e) => {
	const btn = e.target.closest("[data-log-domain]");
	if (!btn) return;
	const select = document.getElementById("log-domain");
	select.value = btn.dataset.logDomain;
	select.dispatchEvent(new Event("change", { bubbles: true }));
	document.getElementById("log").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});

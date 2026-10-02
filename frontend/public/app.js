// ezdyndns dashboard script — external file because traefik's
// enhanced-security middleware sets `script-src 'self'`, which blocks inline
// <script> and inline onclick handlers.
const getToken = () => sessionStorage.getItem("ezdyndns_token");

// htmx 4: event is htmx:config:request, headers at evt.detail.ctx.request.headers
document.body.addEventListener("htmx:config:request", (e) => {
	const t = getToken();
	if (!t) {
		e.preventDefault(); // locked page never fires requests
		return;
	}
	e.detail.ctx.request.headers["x-api-token"] = t;
});

if (getToken()) {
	// Token present from a previous unlock: reveal app and verify.
	document.body.classList.add("authed");
	fetch("/api/status", { headers: { "x-api-token": getToken() } }).then((r) => {
		if (r.ok) {
			htmx.trigger(document.body, "ezdyndns:refresh");
		} else {
			sessionStorage.removeItem("ezdyndns_token");
			document.body.classList.remove("authed");
		}
	});
}

function unlock() {
	const t = document.getElementById("api-token").value.trim();
	if (!t) return;
	const state = document.getElementById("lockstate");
	state.textContent = "checking…";
	state.classList.remove("error");
	fetch("/api/status", { headers: { "x-api-token": t } }).then((r) => {
		if (r.ok) {
			sessionStorage.setItem("ezdyndns_token", t);
			location.reload(); // reload reveals .gated and fires triggers
		} else {
			state.textContent = "wrong token — try again";
			state.classList.add("error");
		}
	});
}

document.getElementById("unlock-btn").addEventListener("click", unlock);
document.getElementById("api-token").addEventListener("keydown", (e) => {
	if (e.key === "Enter") unlock();
});

// ---------- add-service form ----------
const PROVIDERS = {
	namecheap: {
		username: "namecheap username (optional)",
		password: "ddns key",
		hint: "Namecheap: Advanced DNS → Dynamic DNS → per-domain key. Validated on the first update.",
	},
	cloudflare: {
		username: "cloudflare api token",
		password: "",
		hint: "Cloudflare: API token with Zone.DNS Edit. Zone is derived from the domain name.",
	},
	dedyn: {
		username: "desec sts token",
		password: "",
		hint: "deSEC: a dedicated STS token (scope domain/update/ttl/ip4, TTL ≤ your check interval) from desec.io → Tokens.",
	},
};

function syncProviderFields() {
	const sel = document.querySelector('form[name="add-service"] select[name="provider"]')
		?? document.querySelector("#add-service-provider") ?? document.querySelector('select[name="provider"]');
	const hintEl = document.getElementById("provider-hint");
	const userEl = document.getElementById("svc-username");
	const passEl = document.getElementById("svc-password");
	if (!sel || !hintEl || !userEl || !passEl) return;
	const cfg = PROVIDERS[sel.value] ?? PROVIDERS.namecheap;
	userEl.placeholder = cfg.username;
	passEl.placeholder = cfg.password || "—";
	passEl.disabled = !cfg.password;
	hintEl.textContent = cfg.hint;
}

const providerSel = document.querySelector('select[name="provider"]');
if (providerSel) {
	providerSel.addEventListener("change", syncProviderFields);
	syncProviderFields();
}

// Intercept the add-service POST so a failed credential check surfaces a message
// instead of silently ignoring the response (htmx would swallow the 422 JSON).
const addForm = document.getElementById("add-service-form");
if (addForm) {
	addForm.addEventListener("htmx:beforeRequest", (e) => {
		const res = document.getElementById("add-result");
		if (res) { res.textContent = ""; res.className = "hint"; }
	});
	addForm.addEventListener("htmx:afterRequest", (e) => {
		const res = document.getElementById("add-result");
		if (!res) return;
		const xhr = e.detail.xhr;
		if (xhr.status >= 200 && xhr.status < 300) {
			res.textContent = "added ✓";
			res.className = "hint show ok";
			addForm.reset();
			syncProviderFields();
			htmx.trigger(document.body, "ezdyndns:refresh");
		} else {
			let msg = `failed (HTTP ${xhr.status})`;
			try { msg = JSON.parse(xhr.responseText).message ?? msg; } catch {}
			res.textContent = msg;
			res.className = "hint show err";
		}
	});
}

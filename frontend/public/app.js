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

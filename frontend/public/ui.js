// ezdyndns UI layer (ES module): live clocks, Motion feedback and the 3D
// propagation view. Everything here is progressive: without it the
// server-rendered panels, the SVG topology and the UTC times still work.
import { animate } from "/vendor/motion.min.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- clocks: local times, "4 min ago", next-check countdown ----------
const pad = (n) => String(n).padStart(2, "0");
function localize(root = document) {
	for (const el of root.querySelectorAll("time[data-local]")) {
		const d = new Date(el.getAttribute("datetime"));
		if (Number.isNaN(d.getTime())) continue;
		const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		const mode = el.dataset.local;
		el.textContent = mode === "time" ? time : mode === "date" ? date : `${date} ${time}`;
		el.title = d.toString();
	}
}
function relative(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function tick() {
	const now = Date.now();
	for (const el of document.querySelectorAll("time[data-rel]")) {
		el.textContent = relative(now - new Date(el.getAttribute("datetime")).getTime());
	}
	for (const el of document.querySelectorAll("[data-countdown]")) {
		const left = Math.round((new Date(el.dataset.countdown).getTime() - now) / 1000);
		el.textContent = left <= 0 ? "due" : `${Math.floor(left / 60)}:${pad(left % 60)}`;
	}
}
setInterval(tick, 1000);

// ---------- Motion: feedback only, never an entrance ----------
let lastIp = null;
let lastLogId = null;

function onSwap(target) {
	localize(target);
	tick();
	if (target.id === "hero") {
		const ipEl = target.querySelector("[data-ip]");
		const ip = ipEl?.dataset.ip || null;
		// The address changing is the one event worth a visible move.
		if (lastIp && ip && ip !== lastIp && !reduced.matches) {
			animate(ipEl, { opacity: [0, 1], y: [10, 0] }, { duration: 0.45, ease: [0.2, 0.7, 0.2, 1] });
		}
		lastIp = ip;
	}
	if (target.id === "updates") {
		const rows = [...target.querySelectorAll("tr[data-id]")];
		const top = rows[0] ? Number(rows[0].dataset.id) : null;
		if (lastLogId !== null && top !== null) {
			const fresh = rows.filter((r) => Number(r.dataset.id) > lastLogId);
			for (const r of fresh) {
				r.classList.add("is-new");
				requestAnimationFrame(() => requestAnimationFrame(() => r.classList.remove("is-new")));
				if (!reduced.matches) animate(r, { opacity: [0, 1], x: [-6, 0] }, { duration: 0.3 });
			}
		}
		if (top !== null) lastLogId = Math.max(lastLogId ?? 0, top);
	}
	if (target.id === "topology") topology.update(readTopology(target));
	if (target.id === "dialog-body" && !reduced.matches) {
		animate(target.firstElementChild, { opacity: [0, 1], y: [8, 0] }, { duration: 0.22, ease: [0.2, 0.7, 0.2, 1] });
	}
}
document.body.addEventListener("htmx:after:swap", (e) => {
	const t = e.detail.ctx?.target;
	if (t) onSwap(t);
});

// ---------- topology data + log filter options ----------
function readTopology(root) {
	try {
		return JSON.parse(root.querySelector(".topo-json")?.textContent ?? "null");
	} catch {
		return null;
	}
}
function syncLogFilter(data) {
	const select = document.getElementById("log-domain");
	if (!select || !data) return;
	const keep = select.value;
	const opts = data.records.map((r) => `<option value="${r.id}">${r.fqdn.replace(/[<&"]/g, "")}</option>`).join("");
	const html = `<option value="">All records</option>${opts}`;
	if (select.dataset.sig !== html) {
		select.innerHTML = html;
		select.dataset.sig = html;
		select.value = data.records.some((r) => String(r.id) === keep) ? keep : "";
	}
}

// ---------- 3D propagation view (three.js, loaded lazily) ----------
// Your public IP at the centre, each DNS record on a ring around it, linked by
// a line coloured by the record's state. When a check completes, a packet runs
// out along each link: it arrives on records that took the push and stops
// short, in red, on the ones that failed.
const topology = (() => {
	const section = document.querySelector(".topo");
	const stage = document.getElementById("topo-stage");
	let pending = null;
	let api = null;
	let loading = false;

	function update(data) {
		syncLogFilter(data);
		if (!data) return;
		if (api) api.update(data);
		else {
			pending = data;
			load();
		}
	}

	function webglOk() {
		try {
			const c = document.createElement("canvas");
			return !!(c.getContext("webgl2") || c.getContext("webgl"));
		} catch {
			return false;
		}
	}

	async function load() {
		if (loading || !stage || !webglOk()) return;
		loading = true;
		try {
			const THREE = await import("/vendor/three.min.js");
			api = createScene(THREE, stage);
			section.classList.add("is-3d");
			if (pending) api.update(pending);
		} catch (err) {
			console.warn("[ezdyndns] 3D view unavailable, keeping the SVG", err);
		}
	}

	return { update };
})();

function createScene(THREE, stage) {
	const color = (v) => new THREE.Color(css(v));
	const palette = {
		current: color("--positive"),
		pending: color("--warning"),
		failing: color("--negative"),
		paused: color("--muted"),
		new: color("--muted"),
		link: new THREE.Color("#4a4c52"),
		ring: color("--border"),
		home: color("--text"),
		accent: color("--accent"),
	};

	const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
	stage.appendChild(renderer.domElement);

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(32, 2, 0.1, 100);
	camera.position.set(0, 6.2, 10.5);
	camera.lookAt(0, -0.2, 0);

	const world = new THREE.Group();
	scene.add(world);

	// home node: the public IP
	const home = new THREE.LineSegments(
		new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.46, 0)),
		new THREE.LineBasicMaterial({ color: palette.home }),
	);
	const core = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), new THREE.MeshBasicMaterial({ color: palette.accent }));
	scene.add(home, core);

	// orbit the records sit on
	const RADIUS = 3.6;
	const ringPts = [];
	for (let i = 0; i <= 96; i++) {
		const a = (i / 96) * Math.PI * 2;
		ringPts.push(Math.cos(a) * RADIUS, 0, Math.sin(a) * RADIUS);
	}
	const ringGeo = new THREE.BufferGeometry();
	ringGeo.setAttribute("position", new THREE.Float32BufferAttribute(ringPts, 3));
	world.add(new THREE.Line(ringGeo, new THREE.LineBasicMaterial({ color: palette.ring })));

	const labelLayer = stage;
	const homeLabel = document.createElement("div");
	homeLabel.className = "topo-label home";
	labelLayer.appendChild(homeLabel);

	let nodes = []; // { id, mesh, line, label, state, pos }
	let packets = []; // { node, t0, fails }
	let lastCheck = null;
	const nodeGeo = new THREE.SphereGeometry(0.13, 16, 12);

	function clearNodes() {
		for (const n of nodes) {
			world.remove(n.mesh, n.line);
			n.line.geometry.dispose();
			n.line.material.dispose();
			n.mesh.material.dispose();
			n.label.remove();
		}
		nodes = [];
	}

	function update(data) {
		homeLabel.innerHTML = `${escapeHtml(data.ip ?? "—")}<small>public IP</small>`;
		const sig = data.records.map((r) => `${r.id}:${r.state}:${r.fqdn}`).join("|");
		if (sig !== update.sig) {
			update.sig = sig;
			clearNodes();
			data.records.forEach((r, i) => {
				const a = (i / data.records.length) * Math.PI * 2;
				const pos = new THREE.Vector3(Math.cos(a) * RADIUS, 0, Math.sin(a) * RADIUS);
				const mesh = new THREE.Mesh(nodeGeo, new THREE.MeshBasicMaterial({ color: palette[r.state] ?? palette.paused }));
				mesh.position.copy(pos);
				const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), pos]);
				const dashed = r.state !== "current" && r.state !== "pending";
				const mat = dashed
					? new THREE.LineDashedMaterial({ color: r.state === "failing" ? palette.failing : palette.link, dashSize: 0.12, gapSize: 0.1 })
					: new THREE.LineBasicMaterial({ color: palette.link });
				const line = new THREE.Line(geo, mat);
				if (dashed) line.computeLineDistances();
				world.add(mesh, line);
				const label = document.createElement("div");
				label.className = `topo-label state-${r.state}`;
				// Narrow stages show only the first DNS label; the table below has the full name.
				const short = r.fqdn.split(".")[0] || r.fqdn;
				label.innerHTML = `<span class="l-full">${escapeHtml(r.fqdn)}</span><span class="l-short">${escapeHtml(short)}</span><small>${stateWord(r.state)}</small>`;
				labelLayer.appendChild(label);
				nodes.push({ id: r.id, mesh, line, label, state: r.state, pos });
			});
		}
		// A new check timestamp means pushes just ran: send packets.
		if (lastCheck && data.check && data.check !== lastCheck && !reduced.matches) {
			const t0 = performance.now();
			packets = nodes
				.filter((n) => n.state !== "paused" && n.state !== "new")
				.map((n, i) => ({ node: n, t0: t0 + i * 90, fails: n.state === "failing" }));
		}
		lastCheck = data.check;
		wake();
	}

	// packets share one Points object; positions are rewritten per frame
	const MAX_PACKETS = 64;
	const pktGeo = new THREE.BufferGeometry();
	pktGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(MAX_PACKETS * 3), 3));
	pktGeo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(MAX_PACKETS * 3), 3));
	const pkts = new THREE.Points(pktGeo, new THREE.PointsMaterial({ size: 0.16, vertexColors: true, sizeAttenuation: true }));
	world.add(pkts);

	function drawPackets(now) {
		const pos = pktGeo.attributes.position.array;
		const col = pktGeo.attributes.color.array;
		let n = 0;
		packets = packets.filter((p) => now - p.t0 < 1400);
		for (const p of packets) {
			if (n >= MAX_PACKETS) break;
			const t = Math.min(1, Math.max(0, (now - p.t0) / 900));
			const reach = p.fails ? 0.55 : 1;
			const e = 1 - (1 - t) ** 3;
			const v = p.node.pos.clone().multiplyScalar(e * reach);
			pos.set([v.x, v.y, v.z], n * 3);
			const c = p.fails && t > 0.5 ? palette.failing : palette.accent;
			col.set([c.r, c.g, c.b], n * 3);
			n++;
		}
		pktGeo.setDrawRange(0, n);
		pktGeo.attributes.position.needsUpdate = true;
		pktGeo.attributes.color.needsUpdate = true;
	}

	// labels follow their nodes in screen space
	const v = new THREE.Vector3();
	function place(el, worldPos, dy) {
		v.copy(worldPos).project(camera);
		const x = (v.x * 0.5 + 0.5) * stage.clientWidth;
		const y = (-v.y * 0.5 + 0.5) * stage.clientHeight + dy;
		el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
	}

	function resize() {
		const w = stage.clientWidth;
		const h = stage.clientHeight;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		// Fit the ring plus room for its labels: distance from whichever of
		// the horizontal or vertical field of view is tighter.
		const vfov = (camera.fov * Math.PI) / 180;
		const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
		const narrow = w < 520;
		stage.classList.toggle("narrow", narrow);
		const halfW = RADIUS + (narrow ? 0.9 : 1.9); // labels hang off the sides
		const halfH = RADIUS * 0.62 + 0.9; // the ring is foreshortened by the tilt
		const dist = Math.max(halfW / Math.tan(hfov / 2), halfH / Math.tan(vfov / 2));
		camera.position.set(0, dist * 0.5, dist * 0.87);
		camera.lookAt(0, -0.25, 0);
		camera.updateProjectionMatrix();
		wake();
	}
	new ResizeObserver(resize).observe(stage);

	// Render only while visible; with reduced motion, render once per change.
	let visible = true;
	let raf = 0;
	new IntersectionObserver(([e]) => {
		visible = e.isIntersecting;
		wake();
	}).observe(stage);
	document.addEventListener("visibilitychange", wake);

	const wp = new THREE.Vector3();
	function frame(now) {
		raf = 0;
		if (!reduced.matches) {
			world.rotation.y = now * 0.00004;
			home.rotation.y = now * 0.0003;
			home.rotation.x = now * 0.00012;
		}
		drawPackets(now);
		renderer.render(scene, camera);
		place(homeLabel, wp.set(0, -0.95, 0), 0);
		for (const n of nodes) {
			n.label.style.opacity = "1";
			place(n.label, n.mesh.getWorldPosition(wp), 24);
		}
		const animating = !reduced.matches || packets.length > 0;
		if (animating && visible && !document.hidden) raf = requestAnimationFrame(frame);
	}
	function wake() {
		if (!raf) raf = requestAnimationFrame(frame);
	}
	reduced.addEventListener("change", wake);

	return { update };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const stateWord = (s) => ({ current: "current", pending: "behind", failing: "failing", paused: "paused", new: "waiting" })[s] ?? s;

// Panels that loaded before this module ran (htmx fires on load) are caught up here.
for (const id of ["hero", "topology", "updates"]) {
	const el = document.getElementById(id);
	if (el?.childElementCount) onSwap(el);
}
localize();

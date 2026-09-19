#!/usr/bin/env bash
# Seeds ezdyndns from the existing ddclient config (~/ddclient/config/ddclient.conf).
# Reads password values straight from the file — they never hit the terminal.
set -euo pipefail
cd "$(dirname "$0")/../backend"

[ -f .env ] || { echo "backend/.env missing — run scripts/gen-env.sh first"; exit 1; }
set -a; source .env; set +a

CONF="${DDCLIENT_CONF:-$HOME/ddclient/config/ddclient.conf}"
[ -f "$CONF" ] || { echo "ddclient.conf not found at $CONF"; exit 1; }

bun - "$CONF" <<'EOF'
// ddclient.conf is sequential: login=<domain> and password=<key> lines set the
// current credentials, and the following @.<fqdn> line is a host to update with
// them. Parse in order; never print credentials.
import { createService, addDomain, getServices } from "./db.js";

const conf = await Bun.file(process.argv[2]).text();
const lines = conf.split("\n").map((l) => l.trim());

let login = null;
let password = null;
const hosts = []; // { hostname, domainname, password }

for (const raw of lines) {
	if (!raw || raw.startsWith("#")) continue;
	// ddclient allows inline comments: value<TAB># comment — strip them.
	const stripped = raw.replace(/\s+#.*$/, "").trim();
	if (stripped.startsWith("login=")) {
		login = stripped.slice("login=".length).trim();
		continue;
	}
	if (stripped.startsWith("password=")) {
		let pw = stripped.slice("password=".length).trim();
		// ddclient conf values are Perl-style strings: a value wrapped in
		// matching single quotes has the quotes stripped by ddclient itself
		// (verified live: ddclient sent the 32-char inner value, not the
		// 34-char quoted one; the literal ' is a Namecheap-restricted symbol).
		if (pw.length >= 2 && pw.startsWith("'") && pw.endsWith("'")) {
			pw = pw.slice(1, -1);
		}
		password = pw;
		continue;
	}
	// host line: @.example.com  (or sub.example.com)
	if (stripped.startsWith("@")) {
		const fqdn = stripped.replace(/^@\.?/, "");
		if (!fqdn) continue;
		// Namecheap "@.domain" → host "@" (apex), domain = full fqdn.
		// "sub.domain" → host "sub", domain = "domain".
		const hostname = stripped.startsWith("@.") ? "@" : stripped.split(".")[0];
		const domainname = fqdn;
		if (!password) {
			console.error(`no password for ${fqdn} — skipping`);
			continue;
		}
		hosts.push({ hostname, domainname, password });
	}
}

if (hosts.length === 0) {
	console.error("no host entries parsed from ddclient.conf");
	process.exit(1);
}

const existing = getServices().find((s) => s.provider === "namecheap" && s.name === "namecheap");
if (existing) {
	console.log(`service 'namecheap' already exists (id ${existing.id}) — skipping`);
} else {
	const id = createService({ name: "namecheap", provider: "namecheap", interval_sec: 300 });
	for (const d of hosts) {
		addDomain(id, d);
		console.log(`seeded ${d.hostname === "@" ? "@" : d.hostname}.${d.domainname} (encrypted)`);
	}
	console.log(`service 'namecheap' created (id ${id})`);
}
EOF
echo "seed complete."
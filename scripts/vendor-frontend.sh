#!/usr/bin/env bash
# Vendors the frontend's third-party files into frontend/public/vendor/.
# The Traefik CSP is `script-src 'self'; font-src 'self'`, so nothing may load
# from a CDN. Versions are pinned; bump them here and re-run. The output is
# committed so a fresh clone / docker build works without network access.
#
# three and motion are tree-shaken to the symbols the dashboard imports
# (bun build --minify), which keeps three at a fraction of its 660 KB build.
set -euo pipefail

HTMX=4.0.0
THREE=0.186.1
MOTION=14.3.0
FONTS=5.3.0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/frontend/public/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund --ignore-scripts \
	"htmx.org@$HTMX" "three@$THREE" "motion@$MOTION" \
	"@fontsource/public-sans@$FONTS" "@fontsource/ibm-plex-mono@$FONTS" >/dev/null

mkdir -p "$OUT/fonts"

cp node_modules/htmx.org/dist/htmx.min.js "$OUT/htmx.min.js"

cat > three-entry.js <<'EOF'
export {
	BufferGeometry, Color, Float32BufferAttribute, Group, IcosahedronGeometry, Line,
	LineBasicMaterial, LineDashedMaterial, LineSegments, EdgesGeometry, Mesh,
	MeshBasicMaterial, PerspectiveCamera, Points, PointsMaterial, Scene,
	SphereGeometry, Vector3, WebGLRenderer,
} from "three";
EOF
bun build three-entry.js --minify --format=esm --outfile "$OUT/three.min.js" >/dev/null

cat > motion-entry.js <<'EOF'
export { animate, stagger } from "motion";
EOF
bun build motion-entry.js --minify --format=esm --outfile "$OUT/motion.min.js" >/dev/null

for w in 400 500 600; do
	cp "node_modules/@fontsource/public-sans/files/public-sans-latin-$w-normal.woff2" "$OUT/fonts/"
done
for w in 400 500; do
	cp "node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-$w-normal.woff2" "$OUT/fonts/"
done

cat > "$OUT/LICENSES.txt" <<EOF
htmx.org $HTMX — 0BSD — https://github.com/bigskysoftware/htmx
three $THREE — MIT — https://github.com/mrdoob/three.js
motion $MOTION — MIT — https://github.com/motiondivision/motion
Public Sans (@fontsource/public-sans $FONTS) — OFL-1.1
IBM Plex Mono (@fontsource/ibm-plex-mono $FONTS) — OFL-1.1
EOF

ls -la "$OUT" "$OUT/fonts"

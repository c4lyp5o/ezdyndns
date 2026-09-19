#!/usr/bin/env bash
# Generates the two secrets ezdyndns needs and writes them to backend/.env
set -euo pipefail
cd "$(dirname "$0")/../backend"

ENC_KEY=$(openssl rand -base64 32)
API_TOKEN=$(openssl rand -hex 24)

cat > .env <<EOF
EZDYNDNS_ENCRYPTION_KEY=${ENC_KEY}
EZDYNDNS_TOKEN=${API_TOKEN}
PORT=5070
# ntfy push notifications (IP change / update failure / stalled check loop).
# Full topic URL; leave unset to disable. Your ntfy server + a topic you own.
# EZDYNDNS_NTFY_URL=https://ntfy.example.com/ezdyndns
EOF

echo "Wrote backend/.env with a fresh encryption key and API token."
echo "API token: ${API_TOKEN}"
echo "Edit EZDYNDNS_NTFY_URL if you want pushes on a different ntfy topic."

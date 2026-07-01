#!/usr/bin/env bash
# Run on your MAC. Builds the dashboard and pushes it to the Pi.
#
#   ./pi/deploy.sh quinn@missiondeck.local
#   ./pi/deploy.sh quinn@192.168.1.42
#
set -euo pipefail

PI_HOST="${1:?usage: ./deploy.sh <user>@<pi-host>}"
cd "$(dirname "$0")/.."

echo "→ Building production bundle…"
npm run build

echo "→ Syncing dist/ → $PI_HOST:~/mission-deck/dist/"
rsync -av --delete dist/ "$PI_HOST:~/mission-deck/dist/"

echo "→ Restarting static server on the Pi…"
ssh "$PI_HOST" "sudo systemctl restart mission-deck.service" || true

echo "✓ Deployed. The kiosk will show the new build on its next reload (or reboot the Pi)."

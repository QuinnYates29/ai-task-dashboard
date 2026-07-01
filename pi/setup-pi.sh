#!/usr/bin/env bash
# Run ONCE on the Pi (CM5 on Waveshare CM5-NANO-B, booted from microSD).
# Sets up: a local static server for the dashboard + Chromium kiosk on boot.
#
#   curl/scp this file to the Pi, then:  bash setup-pi.sh
#
set -euo pipefail

USER_NAME="$(whoami)"
APP_DIR="$HOME/mission-deck"
PORT=8080

echo "→ Installing Chromium…"
sudo apt update
sudo apt install -y chromium-browser || sudo apt install -y chromium

echo "→ Creating app dir at $APP_DIR/dist"
mkdir -p "$APP_DIR/dist"
# Placeholder so the server has something to serve before first deploy
[ -f "$APP_DIR/dist/index.html" ] || echo "<h1>Mission Deck — waiting for first deploy</h1>" > "$APP_DIR/dist/index.html"

echo "→ Installing static-server systemd service (port $PORT)"
sudo tee /etc/systemd/system/mission-deck.service >/dev/null <<EOF
[Unit]
Description=Mission Deck static server
After=network.target

[Service]
ExecStart=/usr/bin/python3 -m http.server $PORT --directory $APP_DIR/dist
Restart=always
User=$USER_NAME

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now mission-deck.service

echo "→ Disabling screen blanking"
sudo raspi-config nonint do_blanking 1 || true

echo "→ Writing kiosk launch script"
cat > "$APP_DIR/launch-kiosk.sh" <<KIOSK
#!/usr/bin/env bash
URL="http://localhost:$PORT"
# Wait until the static server answers, then launch Chromium full-screen.
until curl -sf "\$URL" >/dev/null; do sleep 1; done
exec chromium-browser --kiosk --ozone-platform=wayland \\
  --noerrdialogs --disable-infobars --no-first-run \\
  --disable-session-crashed-bubble --hide-crash-restore-bubble \\
  --check-for-update-interval=31536000 \\
  --autoplay-policy=no-user-gesture-required "\$URL" \\
  || exec chromium --kiosk --ozone-platform=wayland \\
       --noerrdialogs --disable-infobars --no-first-run \\
       --disable-session-crashed-bubble "\$URL"
KIOSK
chmod +x "$APP_DIR/launch-kiosk.sh"

echo "→ Registering kiosk in labwc autostart (default compositor on Pi OS Bookworm)"
mkdir -p "$HOME/.config/labwc"
AUTOSTART="$HOME/.config/labwc/autostart"
touch "$AUTOSTART"
grep -q launch-kiosk "$AUTOSTART" || echo "$APP_DIR/launch-kiosk.sh &" >> "$AUTOSTART"

echo
echo "✓ Setup complete."
echo "  Deploy the dashboard from your Mac, then reboot:  sudo reboot"
echo "  Static server status:  systemctl status mission-deck.service"

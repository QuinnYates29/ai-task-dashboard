# Mission Deck — Pi Kiosk Kit

Get the dashboard on the wall screen. **Milestone 1: just the UI on screen**,
running fully self-contained on the Pi (localStorage tasks, no Deck Server, no
Ollama, no vault). The thin-client / live-vault path comes later.

Hardware assumed: **CM5 Lite on Waveshare CM5-NANO-B, booting from the carrier's
microSD slot**, ROADOM 10.1" (1024×600) display.

---

## 1. Flash Raspberry Pi OS (on your Mac)

1. Install **Raspberry Pi Imager** → https://www.raspberrypi.com/software/
2. Insert the SanDisk microSD (card reader on the Mac).
3. In Imager:
   - **Device:** Raspberry Pi 5 *(the CM5 uses the same arm64 image)*
   - **OS:** Raspberry Pi OS (64-bit) — the full desktop Bookworm
   - **Storage:** the microSD
4. Click **Next → Edit Settings** (OS customization). This is the important part
   for a headless wall unit:
   - **Hostname:** `missiondeck`
   - **Username / password:** pick one (e.g. `quinn`) — remember it, the deploy
     script uses it
   - **WiFi:** SSID + password + your country
   - **Locale / timezone:** set them
   - **Services tab → Enable SSH** (password auth is fine)
5. **Write**, wait for verify, eject.
6. Put the microSD in the **NANO-B microSD slot**, connect mini-HDMI → display,
   power up. CM5 Lite has no eMMC, so it boots straight from the card — no BOOT
   button / rpiboot needed.
7. First boot expands the filesystem and reboots once. You should land on the
   desktop. Confirm it's reachable from the Mac:
   ```sh
   ping missiondeck.local
   ssh quinn@missiondeck.local
   ```

## 2. Set up the kiosk (on the Pi, once)

Copy this kit over and run the setup script:

```sh
# from your Mac, in this repo:
scp pi/setup-pi.sh quinn@missiondeck.local:~
ssh quinn@missiondeck.local 'bash setup-pi.sh'
```

It installs Chromium, registers a tiny static server on `:8080`
(`mission-deck.service`), disables screen blanking, and adds a Chromium
**kiosk** entry to the labwc autostart so the dashboard launches full-screen on
every boot.

## 3. Deploy the dashboard (from your Mac)

```sh
./pi/deploy.sh quinn@missiondeck.local
```

Builds `dist/` and rsyncs it to the Pi. Then on the Pi:

```sh
sudo reboot
```

The screen should come up straight into Mission Deck, full-screen, no cursor
chrome. Tasks you add persist in the browser's localStorage on the Pi.

---

## Everyday use

- **Push a new build:** `./pi/deploy.sh quinn@missiondeck.local` (kiosk reloads
  on reboot, or `ssh` in and `chromium`-reload).
- **Server status:** `systemctl status mission-deck.service`
- **Exit kiosk to debug:** plug in a keyboard, `Ctrl+Alt+F2` for a TTY, or `ssh`
  in and `pkill chromium`.

## Next milestone (live vault tasks)

When you want real Obsidian tasks instead of localStorage, switch to the
documented **thin-client** design: run the Deck Server (`server/`) + Obsidian
REST API on your Mac, set `deck.hubUrl` / the Obsidian link in the dashboard to
the Mac's LAN IP, and point the kiosk there. See the vault note
`Wall Dashboard - Software` and `server/README.md`.

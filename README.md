# Mission Deck — Quinn's Task Dashboard

React + Vite task dashboard built to run on the Mac today and a dedicated
wall/desk screen later (touch-sized controls, live clock, kiosk-friendly
layout).

## Run

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/ — serve anywhere (Pi, etc.)
```

## Views

- **Today** — Overdue / Due today / On the radar / Done today
- **All tasks** — grouped by project, with search + priority filter
- **Calendar** — month grid, deadlines as project-colored chips, click a day
  to see and complete its tasks
- **Projects** — progress cards; manage projects (add/remove/recolor) from
  the sidebar sheet

Local tasks persist in `localStorage`.

## Obsidian link

Sidebar → **◈ Obsidian link**. Uses the Local REST API plugin exactly as
spec'd in the vault's `HOME.md`:

- Base URL `https://localhost:27124`, `Authorization: Bearer <key>`
- Reads `- [ ]` tasks from configured files (default `DASHBOARD.md`) plus
  today's daily note (`Daily Notes/YYYY-MM-DD.md`)
- Inline tags map to projects (`#fathom`, `#m7`, `#ollama`, `#personal`);
  `#urgent` / `#low` set priority; `📅 YYYY-MM-DD` or `(due: …)` sets deadline
- Completing a vault task writes the `[x]` back to the source note
- Polls every 45s while enabled; **Test connection** button in settings

Self-signed cert: open the base URL in a browser tab once and accept it,
otherwise `fetch()` fails. For a dedicated device, an Electron wrapper (which
can ignore the cert) is the planned path.

## Code map

- `src/App.jsx` — state, views, sync loop
- `src/components/` — `TaskCard`, `Calendar`, `Sheets` (task / projects /
  obsidian-link modals)
- `src/lib/obsidian.js` — REST adapter + markdown task parser
- `src/lib/seed.js` — starter data mirroring the vault's projects

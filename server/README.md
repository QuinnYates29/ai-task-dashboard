# Deck Server — Mission Deck hub

Local-first backend for the task dashboard. Holds all secrets (out of the
browser), proxies the Obsidian vault, and routes AI work **local-first** with
Claude as an opt-in escalation.

## Run

```sh
cd server
npm install
cp .env.example .env     # fill in OBSIDIAN_API_KEY; leave ANTHROPIC_API_KEY blank to stay fully local
npm run dev              # http://127.0.0.1:8787  (watch mode)
```

No build step — runs TypeScript directly via `tsx`.

## Model routing

The router picks per request (`router.ts`):

- `auto` (default) — Ollama if reachable, else Claude
- `local` — Ollama only; **nothing leaves the machine**
- `claude` — Claude only (needs `ANTHROPIC_API_KEY`)

Set `OLLAMA_CHAT_MODEL` to a model you've pulled (`ollama list`). Embeddings use
`OLLAMA_EMBED_MODEL` (default `nomic-embed-text`).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/health` | What's configured + reachable (obsidian / ollama / claude) |
| GET  | `/api/tasks` | Pull parsed tasks from the daily note + configured files |
| POST | `/api/tasks/toggle` | Body `{ task }` — flip a checkbox, write back to the vault |
| POST | `/api/ai/parse` | Body `{ text, projects[], provider? }` — brain-dump → structured tasks |

`/api/ai/parse` returns `{ tasks: [{title, project, priority, deadline, tags}], provider }`.

## Safety

- The `Independent/` vault folder is hard-blocked in `obsidian.ts` — any path
  under it throws before a request is built. Prompt injection can't reach it.
- Daily-note reads/writes go through `/periodic/daily/`, so weekly-subfolder
  nesting is handled by Obsidian, not guessed.

## Map

- `config.ts` — env-driven config
- `obsidian.ts` — vault REST adapter (+ Independent/ guard, self-signed cert handling)
- `tasks.ts` — markdown task parser + toggle (server-side source of truth)
- `router.ts` — local-first model router (`complete`, `embed`)
- `index.ts` — Express app + routes

## Next

- Wire the frontend to `/api/tasks` (replace direct browser→Obsidian calls)
- Vector index (`nomic-embed-text` + LanceDB/sqlite-vec) for RAG grounding
- `/api/ai/chat` (SSE) wired to Claude + the Obsidian MCP server

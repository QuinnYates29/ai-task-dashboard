import express from 'express';
import cors from 'cors';
import { config, obsidianBase } from './config.js';
import * as obsidian from './obsidian.js';
import { pullTasks, pullAllOpenTasks, toggleTask, createTask, editTask, deleteTask, completeTaskByQuery } from './tasks.js';
import { getProjects, addProject, removeProject, updateProject } from './projects.js';
import { ollamaUp, type Provider } from './router.js';
import { openInObsidian } from './obsidian.js';
import { extractTasks, routeChat, routeChatStream, ingestConversation } from './chat.js';
import { reindexTasks, reindexNotes, searchNotes } from './rag.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── health: what's wired and reachable ──────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  const [vault, ollama] = await Promise.all([
    config.obsidian.enabled ? obsidian.ping() : Promise.resolve(false),
    ollamaUp(),
  ]);
  res.json({
    ok: true,
    obsidian: {
      configured: config.obsidian.enabled,
      reachable: vault,
      endpoint: obsidianBase(),
    },
    ollama: { reachable: ollama, chatModel: config.ollama.chatModel, embedModel: config.ollama.embedModel },
    claude: { configured: config.anthropic.enabled, model: config.anthropic.model },
  });
});

// ── projects: persistent project list ────────────────────────────────────────
app.get('/api/projects', (_req, res) => {
  try { res.json({ projects: getProjects() }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', (req, res) => {
  try { res.json({ project: addProject(req.body) }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.put('/api/projects/:id', (req, res) => {
  try { res.json({ project: updateProject(req.params.id, req.body) }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/projects/:id', (req, res) => {
  try { removeProject(req.params.id); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── tasks: proxy the vault through the hub ───────────────────────────────────
app.get('/api/tasks', async (_req, res) => {
  try {
    res.json({ tasks: await pullTasks() });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// All OPEN tasks across the whole vault (deduped) — the cross-vault backlog.
app.get('/api/tasks/all-open', async (_req, res) => {
  try {
    res.json({ tasks: await pullAllOpenTasks() });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/tasks/toggle', async (req, res) => {
  try {
    await toggleTask(req.body?.task);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// Batch-create approved tasks (used by the capture box).
app.post('/api/tasks/create', async (req, res) => {
  const tasks: any[] = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
  if (!tasks.length) return res.status(400).json({ error: 'tasks required' });
  try {
    const created: string[] = [];
    for (const t of tasks) created.push(await createTask(t));
    reindexTasks().catch(() => {}); // refresh RAG grounding in the background
    res.json({ created });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// Edit a task in place (title/project/priority/deadline/tags/done).
app.post('/api/tasks/edit', async (req, res) => {
  if (!req.body?.task) return res.status(400).json({ error: 'task required' });
  try {
    const out = await editTask(req.body.task, req.body.patch ?? {});
    reindexTasks().catch(() => {});
    res.json({ ok: true, ...out });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// Delete a task's line from its note.
app.post('/api/tasks/delete', async (req, res) => {
  if (!req.body?.task) return res.status(400).json({ error: 'task required' });
  try {
    const out = await deleteTask(req.body.task);
    reindexTasks().catch(() => {});
    res.json({ ok: true, ...out });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// Complete the open task that best matches a free-text query.
app.post('/api/tasks/complete', async (req, res) => {
  const query = String(req.body?.query ?? '').trim();
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const out = await completeTaskByQuery(query);
    reindexTasks().catch(() => {});
    res.json({ ok: true, ...out });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// ── AI: parse a brain-dump into structured tasks (local-first) ───────────────
app.post('/api/ai/parse', async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  const projects: any[] = Array.isArray(req.body?.projects) ? req.body.projects : [];
  const provider: Provider = req.body?.provider ?? 'auto';
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    res.json(await extractTasks(text, projects, provider));
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// ── AI: chat — auto-routes simple→local, complex→Claude (with tools) ─────────
app.post('/api/ai/chat', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const projects: any[] = Array.isArray(req.body?.projects) ? req.body.projects : [];
  const mode = req.body?.mode ?? 'auto'; // local | auto | claude
  if (!messages.length) return res.status(400).json({ error: 'messages required' });
  try {
    res.json(await routeChat(messages, projects, mode));
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// ── AI: chat (streaming) — Server-Sent Events ────────────────────────────────
app.post('/api/ai/chat/stream', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const projects: any[] = Array.isArray(req.body?.projects) ? req.body.projects : [];
  const mode = req.body?.mode ?? 'auto';
  if (!messages.length) return res.status(400).json({ error: 'messages required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const emit = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    await routeChatStream(messages, projects, mode, emit);
    emit({ type: 'done' });
  } catch (e: any) {
    emit({ type: 'error', error: e.message });
  } finally {
    res.end();
  }
});

// ── AI: ingest — summarize this conversation + changes, save to the vault ─────
app.post('/api/ai/ingest', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const projects: any[] = Array.isArray(req.body?.projects) ? req.body.projects : [];
  const mode = req.body?.mode ?? 'auto';
  if (!messages.length) return res.status(400).json({ error: 'messages required' });
  try {
    res.json(await ingestConversation(messages, projects, mode));
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// ── smart search: semantic + keyword over the whole vault ────────────────────
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const k = Math.min(Number(req.query.k ?? 6), 12);
  if (!q) return res.json({ notes: [] });
  try {
    res.json({ notes: await searchNotes(q, k) });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// Open a note in the Obsidian app from the dashboard.
app.post('/api/notes/open', async (req, res) => {
  const path = String(req.body?.path ?? '');
  if (!path) return res.status(400).json({ error: 'path required' });
  try {
    await openInObsidian(path);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// ── RAG: rebuild the embedding indexes ───────────────────────────────────────
app.post('/api/rag/reindex', async (req, res) => {
  const scope = req.query.scope ?? 'all'; // tasks | notes | all
  try {
    const out: any = {};
    if (scope === 'tasks' || scope === 'all') out.tasks = await reindexTasks();
    if (scope === 'notes' || scope === 'all') out.notes = await reindexNotes();
    res.json(out);
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(config.port, () => {
  console.log(`Deck Server → http://127.0.0.1:${config.port}`);
  console.log(`  obsidian: ${config.obsidian.enabled ? obsidianBase() : 'not configured'}`);
  console.log(`  ollama:   ${config.ollama.url} (${config.ollama.chatModel})`);
  console.log(`  claude:   ${config.anthropic.enabled ? config.anthropic.model : 'not configured (local-only)'}`);

  // Warm the RAG indexes in the background (tasks first — fast; notes — slower).
  if (config.obsidian.enabled) {
    const warm = (label: string, fn: () => Promise<any>) =>
      fn()
        .then((r) => console.log(`  rag:      ${label}`, r))
        .catch((e) => console.log(`  rag:      ${label} skipped (${e.message})`));

    warm('tasks', reindexTasks);
    warm('notes', reindexNotes);

    // Periodic incremental reindex so edits made in Obsidian show up without a restart.
    const mins = config.rag.reindexMinutes;
    if (mins > 0) {
      setInterval(() => {
        reindexTasks().catch(() => {});
        reindexNotes().catch(() => {});
      }, mins * 60_000);
      console.log(`  rag:      auto-reindex every ${mins} min`);
    }
  }
});

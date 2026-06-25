// Mission Deck MCP server.
//
// Exposes the dashboard's task operations as MCP tools so Claude (Claude Code /
// Claude Desktop) can read and change tasks via your subscription — no API
// credits, no Claude key needed in the dashboard.
//
// It is a thin stdio wrapper over the Deck Server HTTP API (default
// http://127.0.0.1:8787), so it reuses all the vault access, Independent/
// guards, project-tag logic, and secret handling that already live there.
//
// Run: `npm run mcp` (from server/), or point a client at:
//   server/node_modules/.bin/tsx  server/mcp/server.ts
//
// The Deck Server must be running (`npm run dev` in server/) for tools to work.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DECK = (process.env.DECK_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

// ── Deck Server HTTP helpers ─────────────────────────────────────────────────
async function getJSON(path: string): Promise<any> {
  const r = await fetch(DECK + path);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `${path}: ${r.status}`);
  return body;
}

async function postJSON(path: string, payload: any): Promise<any> {
  const r = await fetch(DECK + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `${path}: ${r.status}`);
  return body;
}

// MCP tool results are text blocks; ok() wraps success, fail() surfaces errors.
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

// One-line rendering of a task, including its id so edit/delete can refer back.
function fmtTask(t: any): string {
  const box = t.done ? '✓' : '○';
  const bits = [t.project && t.project !== 'none' ? `#${t.project}` : '', t.priority && t.priority !== 'medium' ? `[${t.priority}]` : '', t.due ? `📅 ${t.due}` : '']
    .filter(Boolean)
    .join(' ');
  return `${box} ${t.title}${bits ? '  ' + bits : ''}\n    id: ${t.id}`;
}

// Resolve a task id (from list_tasks) back to the full task object the Deck
// Server needs to locate the line in the vault.
async function findTask(id: string): Promise<any> {
  const { tasks } = await getJSON('/api/tasks');
  const t = (tasks as any[]).find((x) => x.id === id);
  if (!t) throw new Error(`no task with id "${id}" — run list_tasks again (ids change as the note changes)`);
  return t;
}

const PROJECT = z
  .enum(['fathom', 'm7', 'ollama', 'obd2', 'personal', 'none'])
  .describe('Project bucket. fathom=BIST/FATHOM, m7=M7 Resetter, ollama=Ollama Multi-Agent, obd2=OBD2 CAN Reader, personal, or none.');
const PRIORITY = z.enum(['urgent', 'medium', 'low']);

const server = new McpServer({ name: 'mission-deck', version: '0.1.0' });

// ── list_tasks ───────────────────────────────────────────────────────────────
server.registerTool(
  'list_tasks',
  {
    title: 'List tasks',
    description:
      "Read today's tasks from the Mission Deck dashboard (sourced from the Obsidian daily note). Use this first; the returned ids are needed for edit_task and delete_task.",
    inputSchema: {
      status: z.enum(['open', 'done', 'all']).default('open').describe('Which tasks to return.'),
      project: PROJECT.optional().describe('Optional: only tasks in this project.'),
    },
  },
  async ({ status, project }) => {
    try {
      const { tasks } = await getJSON('/api/tasks');
      let list = tasks as any[];
      if (status === 'open') list = list.filter((t) => !t.done);
      else if (status === 'done') list = list.filter((t) => t.done);
      if (project) list = list.filter((t) => (t.project || 'none') === project);
      if (!list.length) return ok('No matching tasks.');
      return ok(`${list.length} task(s):\n\n${list.map(fmtTask).join('\n\n')}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── create_task ──────────────────────────────────────────────────────────────
server.registerTool(
  'create_task',
  {
    title: 'Create task',
    description: "Add a new task to today's daily note (under ### Todo).",
    inputSchema: {
      title: z.string().describe('The task text.'),
      project: PROJECT.optional(),
      priority: PRIORITY.optional(),
      deadline: z.string().optional().describe('Due date as YYYY-MM-DD.'),
      tags: z.array(z.string()).optional().describe('Extra hashtags (without the #).'),
    },
  },
  async ({ title, project, priority, deadline, tags }) => {
    try {
      const t: any = { title, priority, deadline, tags };
      if (project && project !== 'none') t.project = project;
      const { created } = await postJSON('/api/tasks/create', { tasks: [t] });
      return ok(`Created:\n${(created || []).join('\n')}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── edit_task ────────────────────────────────────────────────────────────────
server.registerTool(
  'edit_task',
  {
    title: 'Edit task',
    description:
      'Change an existing task. Pass the id from list_tasks plus only the fields you want to change.',
    inputSchema: {
      id: z.string().describe('Task id from list_tasks.'),
      title: z.string().optional(),
      project: PROJECT.optional(),
      priority: PRIORITY.optional(),
      deadline: z.string().optional().describe('New due date YYYY-MM-DD (empty string clears it).'),
      tags: z.array(z.string()).optional().describe('Replace the extra hashtags (without #).'),
      done: z.boolean().optional().describe('Mark complete (true) or reopen (false).'),
    },
  },
  async ({ id, ...patch }) => {
    try {
      const task = await findTask(id);
      const { line } = await postJSON('/api/tasks/edit', { task, patch });
      return ok(`Updated:\n${line}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── complete_task ────────────────────────────────────────────────────────────
server.registerTool(
  'complete_task',
  {
    title: 'Complete task',
    description:
      'Mark the open task that best matches a description as done. Use this when you do not have an exact id; otherwise use edit_task with done:true.',
    inputSchema: { query: z.string().describe('A few words from the task title.') },
  },
  async ({ query }) => {
    try {
      const { matched } = await postJSON('/api/tasks/complete', { query });
      return ok(`Completed: ${matched}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── delete_task ──────────────────────────────────────────────────────────────
server.registerTool(
  'delete_task',
  {
    title: 'Delete task',
    description: "Remove a task's line from its note entirely. Pass the id from list_tasks.",
    inputSchema: { id: z.string().describe('Task id from list_tasks.') },
  },
  async ({ id }) => {
    try {
      const task = await findTask(id);
      const { removed } = await postJSON('/api/tasks/delete', { task });
      return ok(`Deleted:\n${removed}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── search_vault ─────────────────────────────────────────────────────────────
server.registerTool(
  'search_vault',
  {
    title: 'Search vault',
    description: 'Semantic + keyword search across the Obsidian vault notes (Independent/ is excluded).',
    inputSchema: {
      query: z.string(),
      k: z.number().int().min(1).max(12).default(6).describe('How many results.'),
    },
  },
  async ({ query, k }) => {
    try {
      const { notes } = await getJSON(`/api/search?q=${encodeURIComponent(query)}&k=${k}`);
      if (!notes?.length) return ok('No matches.');
      const out = notes
        .map((n: any) => `• ${n.path}${n.heading ? ' › ' + n.heading : ''}${n.score != null ? `  (${n.score.toFixed(3)})` : ''}\n  ${(n.text || n.snippet || '').slice(0, 200).replace(/\s+/g, ' ').trim()}`)
        .join('\n\n');
      return ok(out);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── boot ─────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP transport and must stay clean.
  console.error(`Mission Deck MCP ready → Deck Server at ${DECK}`);
}

main().catch((e) => {
  console.error('Mission Deck MCP failed to start:', e);
  process.exit(1);
});

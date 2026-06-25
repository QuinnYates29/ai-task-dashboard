// Chat orchestration with complexity-based routing.
//
//   mode 'local'  → Ollama only
//   mode 'claude' → Claude only (tool-use agent loop)
//   mode 'auto'   → simple retrieval/write → local; complex reasoning → Claude
//
// Local handles fast retrieval + simple create/complete deterministically.
// Claude gets real tools (read tasks, search vault, create, complete) and a
// proper agent loop, so it can plan and act in one turn.
import { config } from './config.js';
import { anthropic, complete, localCompleteStream, type Provider } from './router.js';
import { pullTasks, createTask, completeTaskByQuery } from './tasks.js';
import { searchSimple } from './obsidian.js';
import { appendToDaily, appendToNote } from './notes.js';
import { similarTasks, searchNotes, nearestProject } from './rag.js';

export const ASSISTANT_NAME = 'A.L.F.R.E.D.';

// Stream-event sink for the SSE chat endpoint.
export type Emit = (e: any) => void;

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}
export interface ChatResult {
  text: string;
  provider: 'local' | 'claude';
  actions: { tool: string; detail: string }[];
  note?: string;
}

// ── structured task extraction (shared with /api/ai/parse) ───────────────────
export const TASK_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          project: { type: 'string' },
          priority: { type: 'string', enum: ['urgent', 'medium', 'low'] },
          deadline: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'project', 'priority', 'deadline', 'tags'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

function projectLines(projects: any[]): string {
  return (
    projects.map((p) => `- ${p.id} (${p.name}${p.tag ? ', ' + p.tag : ''})`).join('\n') ||
    '- personal (Personal)'
  );
}

export async function extractTasks(text: string, projects: any[], provider: Provider) {
  const today = new Date().toISOString().slice(0, 10);

  // RAG grounding: show the model how Quinn filed similar past tasks…
  const examples = await similarTasks(text, 5).catch(() => []);
  const exLines = examples
    .filter((e) => e.project && e.project !== 'none')
    .map((e) => `  "${e.title}" → ${e.project}`)
    .join('\n');
  const exampleBlock = exLines
    ? `\nSimilar tasks Quinn filed before — use these to pick the right project:\n${exLines}\n`
    : '';

  // …and a centroid-based prior (nearest project by embedding average).
  const guess = await nearestProject(text).catch(() => null);
  const guessBlock =
    guess && guess.score > 0.5 ? `Most likely project by similarity: ${guess.project} (confirm or override).\n` : '';

  const system = `You convert a brain-dump into structured tasks for Quinn's dashboard.
Today is ${today}.
Set "project" to one of these ids ONLY, or "none" if unclear:
${projectLines(projects)}
${exampleBlock}${guessBlock}"priority" is urgent | medium | low. "deadline" is YYYY-MM-DD, or "" if none is implied.
"tags" are short #tags (include the project's tag when known). Split multiple distinct tasks.
Return JSON only, matching the schema.`;
  const { text: out, provider: used } = await complete(
    { system, user: text, schema: TASK_SCHEMA },
    provider,
  );
  let parsed: any;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error('model did not return valid JSON');
  }

  // Normalize project to a real id — models sometimes return "#fathom" or a tag.
  const tasks = parsed.tasks ?? [];
  if (projects.length) {
    const ids = new Set(projects.map((p) => p.id));
    const tagToId: Record<string, string> = Object.fromEntries(
      projects.map((p) => [(p.tag || '').replace(/^#/, ''), p.id]),
    );
    for (const t of tasks) {
      let proj = String(t.project || '').replace(/^#/, '').trim();
      if (proj && !ids.has(proj)) proj = tagToId[proj] || proj;
      if (proj && !ids.has(proj)) proj = 'none';
      t.project = proj || 'none';
    }
  }
  return { tasks, provider: used };
}

// ── routing heuristics ───────────────────────────────────────────────────────
const COMPLEX =
  /\b(plan|prioriti|why|because|compare|draft|write|email|message|explain|analy|recommend|suggest|strateg|break\s?down|summar|brainstorm|should i|help me|figure out|review|rewrite|outline|estimate|schedule|organi[sz]e)\b/i;

export function isComplex(text: string): boolean {
  if (COMPLEX.test(text)) return true;
  if (text.trim().split(/\s+/).length > 40) return true;
  if ((text.match(/\?/g) || []).length >= 2) return true;
  return false;
}

const CREATE = /\b(add|create|new task|remind me|note to self|jot down|put .* on (my |the )?list)\b/i;
const COMPLETE =
  /\b(mark|complete|completed|finish|finished|check off|cross off|did|done with|i('| )?ve done|tick off)\b/i;

function detectIntent(text: string): 'create' | 'complete' | 'ask' {
  if (CREATE.test(text)) return 'create';
  if (COMPLETE.test(text)) return 'complete';
  return 'ask';
}

function summarizeTasks(tasks: any[]): string {
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const fmt = (t: any) =>
    `- ${t.title}${t.project ? ` [${t.project}]` : ''}${t.deadline ? ` (due ${t.deadline})` : ''} <${t.priority}>`;
  return (
    `OPEN TASKS (${open.length}):\n${open.map(fmt).join('\n') || '(none)'}\n\n` +
    `RECENTLY DONE (${done.length}):\n${done.slice(0, 15).map((t) => `- ${t.title}`).join('\n') || '(none)'}`
  );
}

// Build the local-answer system prompt: task data + semantically relevant notes.
async function askSystem(query: string): Promise<string> {
  let tasks: any[] = [];
  try {
    tasks = await pullTasks();
  } catch {
    /* vault down */
  }
  let noteHits: { path: string; snippet: string; score: number }[] = [];
  try {
    noteHits = await searchNotes(query, 3);
  } catch {
    /* index empty or vault down */
  }
  const notesBlock = noteHits
    .filter((n) => n.score > 0.45)
    .map((n) => `- [${n.path}] ${n.snippet.replace(/\s+/g, ' ')}`)
    .join('\n');

  const today = new Date().toISOString().slice(0, 10);
  return `You are ${ASSISTANT_NAME}, Quinn's task and vault assistant. Today is ${today}.
Answer concisely. Use the task data and notes below when relevant; if they don't cover the question, just answer normally. Cite a note's path when you use it.

${summarizeTasks(tasks)}
${notesBlock ? `\nRELEVANT NOTES:\n${notesBlock}` : ''}`;
}

// ── local path ───────────────────────────────────────────────────────────────
async function chatLocal(messages: ChatMsg[], projects: any[]): Promise<ChatResult> {
  // If the local model supports tool-calling, let it run the full agent loop.
  if (config.ollama.tools) return chatLocalAgent(messages, projects);

  const last = messages[messages.length - 1]?.content ?? '';
  const intent = detectIntent(last);

  if (intent === 'create') {
    const { tasks } = await extractTasks(last, projects, 'local');
    const created: string[] = [];
    for (const t of tasks) created.push(await createTask(t));
    return {
      text: created.length
        ? `Added ${created.length} task${created.length > 1 ? 's' : ''}:\n` +
          created.map((c) => '  ' + c.replace(/^- \[ \] /, '• ')).join('\n')
        : "I couldn't pull a task out of that — try rephrasing.",
      provider: 'local',
      actions: tasks.map((t: any) => ({ tool: 'create_task', detail: t.title })),
    };
  }

  if (intent === 'complete') {
    const query = last.replace(COMPLETE, '').replace(/\b(the|task|my|that|todo)\b/gi, '').trim();
    const { matched } = await completeTaskByQuery(query || last);
    return {
      text: `✓ Marked done: ${matched}`,
      provider: 'local',
      actions: [{ tool: 'complete_task', detail: matched }],
    };
  }

  // question → answer with task + note context injected
  const system = await askSystem(last);
  const { text } = await complete({ system, user: last }, 'local');
  return { text, provider: 'local', actions: [] };
}

// ── Claude path (agent loop with tools) ──────────────────────────────────────
const CHAT_TOOLS = [
  {
    name: 'list_tasks',
    description: "List Quinn's current tasks (open and done) from the vault.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_vault',
    description: 'Full-text search the Obsidian vault for notes matching a query.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_task',
    description: "Add a new task to today's daily note.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        project: { type: 'string' },
        priority: { type: 'string', enum: ['urgent', 'medium', 'low'] },
        deadline: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'complete_task',
    description: 'Mark an existing open task as done by describing it.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_notes',
    description:
      'Semantic search over the whole Obsidian vault. Returns the most relevant note sections (with their file paths) — use this to answer from notes or to find the right note to append to.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_to_note',
    description:
      "Append markdown under a heading in an EXISTING vault note (found via search_notes). Never invent paths; never create new notes. Use this to save info to the most relevant note.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Exact vault path from search_notes' },
        heading: { type: 'string', description: 'Heading to append under (created if missing)' },
        content: { type: 'string', description: 'Markdown to append' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_to_daily',
    description: "Append a markdown line/block under a heading in today's daily note (created if missing). Use to log a one-line summary.",
    input_schema: {
      type: 'object',
      properties: {
        heading: { type: 'string', description: 'e.g. Notes or Done' },
        content: { type: 'string' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
];

async function runTool(name: string, input: any): Promise<string> {
  if (name === 'list_tasks') return JSON.stringify(await pullTasks());
  if (name === 'search_vault') return JSON.stringify(await searchSimple(input.query)).slice(0, 4000);
  if (name === 'create_task') return 'Created: ' + (await createTask(input));
  if (name === 'complete_task') {
    const { matched } = await completeTaskByQuery(input.query);
    return 'Completed: ' + matched;
  }
  if (name === 'search_notes') return JSON.stringify(await searchNotes(input.query, 5));
  if (name === 'append_to_note') {
    return 'Appended to ' + (await appendToNote(input.path, input.heading || 'Notes', input.content));
  }
  if (name === 'append_to_daily') {
    await appendToDaily(input.heading || 'Notes', input.content);
    return 'Appended to daily note';
  }
  return 'unknown tool';
}

async function chatClaude(messages: ChatMsg[], projects: any[]): Promise<ChatResult> {
  if (!anthropic) throw new Error('Claude not configured');
  const today = new Date().toISOString().slice(0, 10);
  const system = `You are ${ASSISTANT_NAME}, Quinn's task and vault assistant. Today is ${today}.
Projects (use these ids for a task's project):
${projectLines(projects)}
You can read tasks, search the vault, create tasks, and complete tasks via tools.
When asked to add or finish something, just do it with the tools, then confirm briefly.
Be concise and action-oriented. Never access anything under Independent/.`;

  const convo: any[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const actions: { tool: string; detail: string }[] = [];

  for (let step = 0; step < 6; step++) {
    const res: any = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 2048,
      system,
      tools: CHAT_TOOLS as any,
      messages: convo,
    });
    convo.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') {
      const text = res.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim();
      return { text: text || '(done)', provider: 'claude', actions };
    }

    const toolResults: any[] = [];
    for (const block of res.content) {
      if (block.type === 'tool_use') {
        let out: string;
        try {
          out = await runTool(block.name, block.input);
          actions.push({ tool: block.name, detail: shortDetail(block.name, block.input) });
        } catch (e: any) {
          out = 'Error: ' + e.message;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
      }
    }
    convo.push({ role: 'user', content: toolResults });
  }
  return { text: 'Stopped after several steps — try narrowing the request.', provider: 'claude', actions };
}

function shortDetail(name: string, input: any): string {
  if (name === 'create_task') return input.title ?? '';
  if (name === 'complete_task') return input.query ?? '';
  if (name === 'search_vault' || name === 'search_notes') return input.query ?? '';
  if (name === 'append_to_note') return input.path ?? '';
  if (name === 'append_to_daily') return 'daily note';
  return '';
}

// ── local tool-calling agent (opt-in via OLLAMA_TOOLS) ───────────────────────
const LOCAL_TOOLS = CHAT_TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

async function chatLocalAgent(messages: ChatMsg[], projects: any[]): Promise<ChatResult> {
  const today = new Date().toISOString().slice(0, 10);
  const system = `You are ${ASSISTANT_NAME}, Quinn's task and vault assistant. Today is ${today}.
Projects (use these ids for a task's project):
${projectLines(projects)}
Use your tools to read tasks, search the vault, create tasks, complete tasks, and save notes. Be concise and action-oriented. Never access anything under Independent/.`;

  const convo: any[] = [
    { role: 'system', content: system },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const actions: { tool: string; detail: string }[] = [];

  for (let step = 0; step < 5; step++) {
    const r = await fetch(`${config.ollama.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.ollama.chatModel, messages: convo, tools: LOCAL_TOOLS, stream: false }),
    });
    if (!r.ok) throw new Error(`ollama chat: ${r.status} ${r.statusText}`);
    const j: any = await r.json();
    const msg = j.message ?? {};
    convo.push(msg);

    const calls = msg.tool_calls ?? [];
    if (!calls.length) return { text: msg.content ?? '', provider: 'local', actions };

    for (const call of calls) {
      const name = call.function?.name;
      let input = call.function?.arguments ?? {};
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          input = {};
        }
      }
      let out: string;
      try {
        out = await runTool(name, input);
        actions.push({ tool: name, detail: shortDetail(name, input) });
      } catch (e: any) {
        out = 'Error: ' + e.message;
      }
      convo.push({ role: 'tool', content: out });
    }
  }
  return { text: 'Stopped after several steps — try narrowing the request.', provider: 'local', actions };
}

function decideProvider(
  mode: 'local' | 'auto' | 'claude',
  last: string,
): { provider: 'local' | 'claude'; note?: string } {
  let provider: 'local' | 'claude';
  if (mode === 'local') provider = 'local';
  else if (mode === 'claude') provider = 'claude';
  else provider = isComplex(last) ? 'claude' : 'local';

  if (provider === 'claude' && !config.anthropic.enabled) {
    return {
      provider: 'local',
      note: 'Claude not configured — answered locally. Add ANTHROPIC_API_KEY to enable escalation.',
    };
  }
  return { provider };
}

// ── non-streaming entry point ────────────────────────────────────────────────
export async function routeChat(
  messages: ChatMsg[],
  projects: any[],
  mode: 'local' | 'auto' | 'claude',
): Promise<ChatResult> {
  const last = messages[messages.length - 1]?.content ?? '';
  const { provider, note } = decideProvider(mode, last);
  const result = provider === 'claude' ? await chatClaude(messages, projects) : await chatLocal(messages, projects);
  if (note) result.note = note;
  return result;
}

// ── streaming entry point ────────────────────────────────────────────────────
// Emits events: {type:'meta',provider} {type:'delta',text} {type:'action',tool,detail}
// {type:'note',note} — the caller appends {type:'done'} / {type:'error'}.
export async function routeChatStream(
  messages: ChatMsg[],
  projects: any[],
  mode: 'local' | 'auto' | 'claude',
  emit: Emit,
): Promise<void> {
  const last = messages[messages.length - 1]?.content ?? '';
  const { provider, note } = decideProvider(mode, last);
  emit({ type: 'meta', provider });
  if (note) emit({ type: 'note', note });
  if (provider === 'claude') await chatClaudeStream(messages, projects, emit);
  else await chatLocalStream(messages, projects, emit);
}

async function chatLocalStream(messages: ChatMsg[], projects: any[], emit: Emit): Promise<void> {
  // Tool-calling local models run the agent loop (non-streamed), then we emit the result.
  if (config.ollama.tools) {
    const res = await chatLocalAgent(messages, projects);
    res.actions.forEach((a) => emit({ type: 'action', tool: a.tool, detail: a.detail }));
    emit({ type: 'delta', text: res.text });
    return;
  }

  const last = messages[messages.length - 1]?.content ?? '';
  const intent = detectIntent(last);

  if (intent === 'create') {
    const { tasks } = await extractTasks(last, projects, 'local');
    const created: string[] = [];
    for (const t of tasks) {
      created.push(await createTask(t));
      emit({ type: 'action', tool: 'create_task', detail: t.title });
    }
    emit({
      type: 'delta',
      text: created.length
        ? `Added ${created.length} task${created.length > 1 ? 's' : ''}:\n` +
          created.map((c) => '  ' + c.replace(/^- \[ \] /, '• ')).join('\n')
        : "I couldn't pull a task out of that — try rephrasing.",
    });
    return;
  }

  if (intent === 'complete') {
    const query = last.replace(COMPLETE, '').replace(/\b(the|task|my|that|todo)\b/gi, '').trim();
    const { matched } = await completeTaskByQuery(query || last);
    emit({ type: 'action', tool: 'complete_task', detail: matched });
    emit({ type: 'delta', text: `✓ Marked done: ${matched}` });
    return;
  }

  const system = await askSystem(last);
  await localCompleteStream({ system, user: last }, (d) => emit({ type: 'delta', text: d }));
}

async function chatClaudeStream(messages: ChatMsg[], projects: any[], emit: Emit): Promise<void> {
  if (!anthropic) throw new Error('Claude not configured');
  const today = new Date().toISOString().slice(0, 10);
  const system = `You are ${ASSISTANT_NAME}, Quinn's task and vault assistant. Today is ${today}.
Projects (use these ids for a task's project):
${projectLines(projects)}
You can read tasks, search the vault, create tasks, and complete tasks via tools.
When asked to add or finish something, just do it with the tools, then confirm briefly.
Be concise and action-oriented. Never access anything under Independent/.`;

  const convo: any[] = messages.map((m) => ({ role: m.role, content: m.content }));

  for (let step = 0; step < 6; step++) {
    const stream: any = (anthropic as any).messages.stream({
      model: config.anthropic.model,
      max_tokens: 2048,
      system,
      tools: CHAT_TOOLS as any,
      messages: convo,
    });
    stream.on('text', (delta: string) => emit({ type: 'delta', text: delta }));
    const msg: any = await stream.finalMessage();
    convo.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason !== 'tool_use') return;

    const toolResults: any[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        let out: string;
        try {
          out = await runTool(block.name, block.input);
          emit({ type: 'action', tool: block.name, detail: shortDetail(block.name, block.input) });
        } catch (e: any) {
          out = 'Error: ' + e.message;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
      }
    }
    convo.push({ role: 'user', content: toolResults });
  }
  emit({ type: 'delta', text: '\n(stopped after several steps)' });
}

// ── ingest: summarize this conversation + changes, write to the vault ─────────
const INGEST_PROMPT = `Summarize our conversation above into concise notes, capturing key info, decisions, and any changes you made (tasks created/completed).
Then SAVE them: use search_notes to find the single most relevant existing note and append the summary there under a sensible heading. If nothing fits well, append to today's daily note instead.
ALWAYS also append a one-line summary under the daily note's "Notes" heading.
Never create new notes. Finally, tell me exactly where you saved it.`;

async function ingestLocal(messages: ChatMsg[]): Promise<ChatResult> {
  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')
    .slice(0, 12000);
  const system = `Summarize this assistant conversation into 3-7 concise markdown bullet points capturing key info, decisions, and any tasks created or completed. Output only the bullets, no preamble.`;
  const { text: summary } = await complete({ system, user: transcript }, 'local');
  const stamp = new Date().toLocaleString();
  const body = summary
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('-') || l.startsWith('*') ? '  ' + l : '  - ' + l))
    .join('\n');
  const block = `- **A.L.F.R.E.D. session — ${stamp}**\n${body}`;
  await appendToDaily('Notes', block);
  return {
    text: `Saved a summary of our conversation to today's daily note under **### Notes**.`,
    provider: 'local',
    actions: [{ tool: 'append_to_daily', detail: 'today · Notes' }],
  };
}

export async function ingestConversation(
  messages: ChatMsg[],
  projects: any[],
  mode: 'local' | 'auto' | 'claude',
): Promise<ChatResult> {
  const wantClaude = mode !== 'local';
  if (wantClaude && config.anthropic.enabled) {
    return chatClaude([...messages, { role: 'user', content: INGEST_PROMPT }], projects);
  }
  const res = await ingestLocal(messages);
  if (wantClaude && !config.anthropic.enabled) {
    res.note =
      'Claude not configured — summarized locally to the daily note. Add ANTHROPIC_API_KEY to let A.L.F.R.E.D. route it to the right project note.';
  }
  return res;
}

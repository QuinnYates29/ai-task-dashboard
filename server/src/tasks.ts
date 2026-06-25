// Parse tasks out of vault markdown and toggle their checkboxes.
// Mirrors the frontend parser so the server can become the single source of truth.
import { config } from './config.js';
import { readDaily, writeDaily, vaultGet, vaultPut, listFiles } from './obsidian.js';

const CHECKBOX = /^(\s*)- \[( |x|X)\] (.+)$/;
const LISTITEM = /^\s*(?:\d+\.|[-*])\s+(.+)$/;

// Vault tags → dashboard project ids (per HOME.md project table).
const TAG_PROJECT: Record<string, string> = {
  fathom: 'fathom',
  m7: 'm7',
  ollama: 'ollama',
  obd2: 'obd2',
  personal: 'personal',
};
// Reverse: project id → vault tag, for writing new tasks.
const PROJECT_TAG: Record<string, string> = {
  fathom: '#fathom',
  m7: '#m7',
  ollama: '#ollama',
  obd2: '#obd2',
  personal: '#personal',
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Target = { type: 'daily' } | { type: 'vault'; path: string };

function extractMeta(raw: string) {
  const tags = [...raw.matchAll(/#([\w/-]+)/g)].map((x) => x[1].toLowerCase());
  const due =
    raw.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1] ||
    raw.match(/\(due:?\s*(\d{4}-\d{2}-\d{2})\)/i)?.[1] ||
    '';
  const title = raw
    .replace(/#[\w/-]+/g, '')
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\(due:?\s*\d{4}-\d{2}-\d{2}\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Specific project tags win over the generic #personal category — tasks are
  // often tagged "#personal #ollama" and the project (#ollama) is the real one.
  let project = '';
  for (const id of ['fathom', 'm7', 'ollama', 'obd2', 'personal']) {
    if (tags.includes(id) && TAG_PROJECT[id]) {
      project = TAG_PROJECT[id];
      break;
    }
  }
  const priority = tags.includes('urgent') ? 'urgent' : tags.includes('low') ? 'low' : 'medium';
  return { title, tags, due, project, priority };
}

function parseTasks(content: string, target: Target, idKey: string, today: string): any[] {
  const tasks: any[] = [];
  let section = '';
  content.split('\n').forEach((line, i) => {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { section = h[1].toLowerCase().trim(); return; }

    const cb = line.match(CHECKBOX);
    if (cb) {
      const meta = extractMeta(cb[3].trim());
      if (!meta.title) return;
      tasks.push({
        id: `ob:${idKey}:${i}`,
        ...meta,
        notes: meta.tags.length ? meta.tags.map((t) => '#' + t).join(' ') : '',
        done: cb[2].toLowerCase() === 'x',
        doneDate: cb[2].toLowerCase() === 'x' ? today : '',
        source: 'obsidian',
        section,
        ob: { target, lineNo: i, raw: cb[3].trim(), readonly: false },
      });
      return;
    }

    if (/done/.test(section)) {
      const li = line.match(LISTITEM);
      if (li && li[1].trim() && !li[1].includes('[ ]') && !li[1].includes('[x]')) {
        const meta = extractMeta(li[1].trim());
        if (!meta.title) return;
        tasks.push({
          id: `ob:${idKey}:${i}`,
          ...meta,
          notes: meta.tags.length ? meta.tags.map((t) => '#' + t).join(' ') : '',
          done: true,
          doneDate: today,
          source: 'obsidian',
          section,
          ob: { target, lineNo: i, raw: li[1].trim(), readonly: true },
        });
      }
    }
  });
  return tasks;
}

async function readTarget(target: Target): Promise<string | null> {
  return target.type === 'daily' ? readDaily() : vaultGet(target.path);
}
async function writeTarget(target: Target, content: string): Promise<void> {
  return target.type === 'daily' ? writeDaily(content) : vaultPut(target.path, content);
}

// Scan the WHOLE vault for tasks (deduped title→project pairs). Used only to
// build the RAG grounding index — not the dashboard views, which stay scoped to
// today. Gives classification hundreds of real "how Quinn files this" examples.
export async function collectAllTasks(): Promise<{ title: string; project: string; done: boolean }[]> {
  const paths = await listFiles('');
  const seen = new Set<string>();
  const out: { title: string; project: string; done: boolean }[] = [];
  for (const p of paths) {
    let content: string | null;
    try {
      content = await vaultGet(p);
    } catch {
      continue;
    }
    if (content == null) continue;
    for (const line of content.split('\n')) {
      const cb = line.match(CHECKBOX);
      if (!cb) continue;
      const meta = extractMeta(cb[3].trim());
      if (!meta.title) continue;
      const key = meta.title.toLowerCase() + '|' + (meta.project || 'none');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title: meta.title, project: meta.project || 'none', done: cb[2].toLowerCase() === 'x' });
    }
  }
  return out;
}

// Scan the WHOLE vault and return every OPEN task as a fully-editable task
// object (carries ob.target/lineNo/raw so toggle/edit/delete write straight back
// to the source note). Powers the cross-vault "Backlog" view. Deduped by title:
// carry-forward copies the same task across many daily notes, so we keep a single
// occurrence — the one in the most-recently-dated note, which becomes the
// editable source.
export async function pullAllOpenTasks(): Promise<any[]> {
  const today = todayISO();
  const all = await listFiles('');
  // Only daily notes and project notes are real task sources — skip testing logs
  // (e.g. "Popoto Testing/"), templates, and loose root notes.
  const dailyPrefix = config.obsidian.dailyFolder.replace(/\/$/, '') + '/';
  const paths = all.filter((p) => p.startsWith(dailyPrefix) || p.startsWith('Projects/'));
  const byTitle = new Map<string, { task: any; date: string }>();

  for (const path of paths) {
    let content: string | null;
    try {
      content = await vaultGet(path);
    } catch {
      continue;
    }
    if (content == null) continue;
    // Date embedded in a daily-note filename (YYYY-MM-DD); '' for other notes,
    // so a dated daily-note occurrence always wins the dedupe.
    const noteDate = path.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
    for (const t of parseTasks(content, { type: 'vault', path }, path, today)) {
      if (t.done || t.ob?.readonly) continue;
      const key = t.title.toLowerCase();
      const prev = byTitle.get(key);
      if (!prev || noteDate >= prev.date) byTitle.set(key, { task: t, date: noteDate });
    }
  }
  return [...byTitle.values()].map((v) => v.task);
}

export async function pullTasks(): Promise<any[]> {
  const today = todayISO();
  const tasks: any[] = [];

  const daily = await readDaily();
  if (daily != null) tasks.push(...parseTasks(daily, { type: 'daily' }, 'daily', today));

  for (const path of config.obsidian.files) {
    const content = await vaultGet(path);
    if (content != null) tasks.push(...parseTasks(content, { type: 'vault', path }, path, today));
  }
  return tasks;
}

// Find a task's line in a note: trust the recorded line number, but fall back to
// matching the raw text if the note shifted since it was read.
function locate(lines: string[], lineNo: number, raw: string): number {
  const innerOf = (l: string | undefined) => l?.match(CHECKBOX)?.[3]?.trim();
  if (innerOf(lines[lineNo]) === raw) return lineNo;
  return lines.findIndex((l) => innerOf(l) === raw);
}

export async function toggleTask(task: any): Promise<void> {
  if (task?.ob?.readonly) throw new Error('display-only item — edit it in Obsidian');
  const { target, lineNo, raw } = task.ob;
  const content = await readTarget(target);
  if (content == null) throw new Error('source note not found');

  const lines = content.split('\n');
  const idx = locate(lines, lineNo, raw);
  if (idx < 0) throw new Error('task moved in note — sync and try again');

  const m = lines[idx].match(CHECKBOX)!;
  const mark = m[2].toLowerCase() === 'x' ? ' ' : 'x';
  lines[idx] = `${m[1]}- [${mark}] ${m[3]}`;
  await writeTarget(target, lines.join('\n'));
}

// Project ids + priority keywords that buildLine re-emits from the canonical
// project/priority fields — stripped from free tags so an edit can't leave a
// stale "#fathom" behind when the project changes.
const MANAGED_TAGS = new Set(['fathom', 'm7', 'ollama', 'obd2', 'personal', 'urgent', 'low']);

// Build a vault task line: "- [mark] Title #tags 📅 YYYY-MM-DD"
function buildLine(mark: ' ' | 'x', t: any, indent = ''): string {
  const tags = new Set<string>(
    (t.tags ?? [])
      .map((x: string) => x.replace(/^#/, '').toLowerCase())
      .filter((x: string) => x && !MANAGED_TAGS.has(x))
      .map((x: string) => '#' + x),
  );
  if (t.priority === 'urgent') tags.add('#urgent');
  if (t.priority === 'low') tags.add('#low');
  if (t.project && PROJECT_TAG[t.project]) tags.add(PROJECT_TAG[t.project]);

  let line = `${indent}- [${mark}] ${String(t.title).trim()}`;
  if (tags.size) line += ' ' + [...tags].join(' ');
  const due = t.deadline || t.due;
  if (due) line += ` 📅 ${due}`;
  return line;
}

const taskLine = (t: any) => buildLine(' ', t);

// Edit an existing task in place: merge `patch` (any of title/project/priority/
// deadline/tags/done) over the current line and rewrite it.
export async function editTask(task: any, patch: any = {}): Promise<{ line: string }> {
  if (task?.ob?.readonly) throw new Error('display-only item — edit it in Obsidian');
  const { target, lineNo, raw } = task.ob;
  const content = await readTarget(target);
  if (content == null) throw new Error('source note not found');

  const lines = content.split('\n');
  const idx = locate(lines, lineNo, raw);
  if (idx < 0) throw new Error('task moved in note — sync and try again');

  const m = lines[idx].match(CHECKBOX)!;
  const cur = extractMeta(m[3].trim());
  const mark: ' ' | 'x' =
    patch.done === true ? 'x' : patch.done === false ? ' ' : (m[2].toLowerCase() === 'x' ? 'x' : ' ');

  const merged = {
    title: patch.title ?? cur.title,
    tags: patch.tags ?? cur.tags,
    priority: patch.priority ?? cur.priority,
    project: patch.project ?? cur.project,
    deadline: patch.deadline ?? patch.due ?? cur.due,
  };
  const line = buildLine(mark, merged, m[1]);
  lines[idx] = line;
  await writeTarget(target, lines.join('\n'));
  return { line: line.trim() };
}

// Remove a task's line from its note entirely.
export async function deleteTask(task: any): Promise<{ removed: string }> {
  if (task?.ob?.readonly) throw new Error('display-only item — edit it in Obsidian');
  const { target, lineNo, raw } = task.ob;
  const content = await readTarget(target);
  if (content == null) throw new Error('source note not found');

  const lines = content.split('\n');
  const idx = locate(lines, lineNo, raw);
  if (idx < 0) throw new Error('task moved in note — sync and try again');

  const [removed] = lines.splice(idx, 1);
  await writeTarget(target, lines.join('\n'));
  return { removed: removed.trim() };
}

// Append a new task under "### Todo" in today's daily note (creates it if needed).
export async function createTask(t: any): Promise<string> {
  if (!t?.title || !String(t.title).trim()) throw new Error('task needs a title');
  const content = (await readDaily()) ?? '';
  const line = taskLine(t);
  let lines = content.split('\n');

  const todoIdx = lines.findIndex((l) => /^#{1,6}\s+todo\b/i.test(l));
  if (todoIdx >= 0) {
    lines.splice(todoIdx + 1, 0, line);
  } else if (content.trim() === '') {
    lines = ['### Todo', line, ''];
  } else {
    lines.push('', '### Todo', line);
  }
  await writeDaily(lines.join('\n'));
  return line;
}

// Find the best open task matching a free-text description and mark it done.
export async function completeTaskByQuery(query: string): Promise<{ matched: string }> {
  const q = query.toLowerCase().trim();
  if (!q) throw new Error('describe which task to complete');
  const open = (await pullTasks()).filter((t) => !t.done && !t.ob?.readonly);

  const tokens = q.split(/\s+/).filter((w) => w.length > 2);
  let best: any = null;
  let bestScore = 0;
  for (const t of open) {
    const title = t.title.toLowerCase();
    let score = title.includes(q) ? 10 : 0;
    for (const tok of tokens) if (title.includes(tok)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (!best || bestScore === 0) throw new Error(`no open task matches "${query}"`);
  await toggleTask(best);
  return { matched: best.title };
}

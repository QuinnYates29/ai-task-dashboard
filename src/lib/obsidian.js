// Obsidian Local REST API adapter — coddingtonbear/obsidian-local-rest-api
//
// Endpoints (same plugin):
//   HTTPS  https://127.0.0.1:27124  — self-signed cert, must be trusted once
//   HTTP   http://127.0.0.1:27123   — no cert, enable under Settings → Local REST API
//
// Daily notes are read AND written through the /periodic/daily/ endpoint, which
// respects Obsidian's own daily-note config (folder, nesting, naming). This is
// why reads worked but path-guessed writes failed — Quinn's daily notes live in
// weekly subfolders like "Daily Notes/Week of Jun 8/2026-06-12.md".

export const DEFAULT_LINK = {
  enabled: false,
  useHttp: true,
  baseUrl: 'http://127.0.0.1:27123',
  apiKey: '',
  files: [],               // extra static files to scan (e.g. a project backlog note)
  dailyFolder: 'Daily Notes',
  includeDaily: true,      // pull tasks from today's daily note
};

function base(link) {
  if (link.baseUrl && !link.baseUrl.includes('27124') && !link.baseUrl.includes('27123')) {
    return link.baseUrl;
  }
  return link.useHttp ? 'http://127.0.0.1:27123' : 'https://127.0.0.1:27124';
}

function headers(link, extra = {}) {
  return { Authorization: `Bearer ${link.apiKey}`, ...extra };
}

function vaultUrl(link, path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${base(link)}/vault/${encoded}`;
}

// A "target" describes where a note lives so reads and writes hit the same place.
//   { type: 'daily' }          → /periodic/daily/
//   { type: 'vault', path }    → /vault/<path>
function targetUrl(link, target) {
  return target.type === 'daily' ? `${base(link)}/periodic/daily/` : vaultUrl(link, target.path);
}

async function readTarget(link, target) {
  const res = await fetch(targetUrl(link, target), { headers: headers(link) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${describe(target)}: ${res.status} ${res.statusText}`);
  return res.text();
}

async function writeTarget(link, target, content) {
  const res = await fetch(targetUrl(link, target), {
    method: 'PUT',
    headers: headers(link, { 'Content-Type': 'text/markdown' }),
    body: content,
  });
  if (!res.ok) throw new Error(`PUT ${describe(target)}: ${res.status} ${res.statusText}`);
}

function describe(target) {
  return target.type === 'daily' ? "today's daily note" : target.path;
}

// ── parsing ──────────────────────────────────────────────────────────────────

const CHECKBOX = /^(\s*)- \[( |x|X)\] (.+)$/;
const LISTITEM = /^\s*(?:\d+\.|[-*])\s+(.+)$/; // numbered or bullet, no checkbox

const TAG_PROJECT = { fathom: 'fathom', m7: 'm7', ollama: 'ollama', obd2: 'obd2', personal: 'personal' };

function extractMeta(rawText) {
  const tags = [...rawText.matchAll(/#([\w/-]+)/g)].map((x) => x[1].toLowerCase());
  const due =
    rawText.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1] ||
    rawText.match(/\(due:?\s*(\d{4}-\d{2}-\d{2})\)/i)?.[1] ||
    '';
  const title = rawText
    .replace(/#[\w/-]+/g, '')
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\(due:?\s*\d{4}-\d{2}-\d{2}\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  let project = '';
  for (const tag of tags) if (TAG_PROJECT[tag]) { project = TAG_PROJECT[tag]; break; }
  const priority = tags.includes('urgent') ? 'urgent' : tags.includes('low') ? 'low' : 'medium';

  return { title, tags, due, project, priority };
}

// Walk a note, tracking the current heading so we know which section each line
// belongs to. Returns dashboard task objects.
function parseTasks(content, target, idKey, todayISO) {
  const tasks = [];
  let section = '';

  content.split('\n').forEach((line, i) => {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { section = h[1].toLowerCase().trim(); return; }

    const cb = line.match(CHECKBOX);
    if (cb) {
      const indent = cb[1];
      const done = cb[2].toLowerCase() === 'x';
      const inner = cb[3].trim();
      const meta = extractMeta(inner);
      if (!meta.title) return;
      tasks.push({
        id: `ob:${idKey}:${i}`,
        ...meta,
        notes: meta.tags.length ? meta.tags.map((t) => '#' + t).join(' ') : '',
        done,
        doneDate: done ? todayISO : '',
        created: '',
        source: 'obsidian',
        section,
        ob: { target, lineNo: i, raw: inner, indent, readonly: false },
      });
      return;
    }

    // Non-checkbox bullets/numbered items under a "Done" heading → display-only
    // completed entries (e.g. older notes that logged completions as `1. …`).
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
          doneDate: todayISO,
          created: '',
          source: 'obsidian',
          section,
          ob: { target, lineNo: i, raw: li[1].trim(), readonly: true },
        });
      }
    }
  });

  return tasks;
}

// ── public API ───────────────────────────────────────────────────────────────

export async function pullTasks(link, todayISO) {
  const tasks = [];

  if (link.includeDaily) {
    const target = { type: 'daily' };
    const content = await readTarget(link, target);
    if (content != null) tasks.push(...parseTasks(content, target, 'daily', todayISO));
  }

  for (const path of link.files || []) {
    const target = { type: 'vault', path };
    const content = await readTarget(link, target);
    if (content != null) tasks.push(...parseTasks(content, target, path, todayISO));
  }

  return tasks;
}

// Flip a task's checkbox and write the whole note back. Re-reads first and
// matches the line by its text (not just index) so a note edited in Obsidian
// since the last sync fails loudly instead of corrupting the wrong line.
export async function toggleTask(link, task) {
  if (task.ob?.readonly) {
    throw new Error('display-only item — edit it in Obsidian');
  }
  const { target, lineNo, raw } = task.ob;
  const content = await readTarget(link, target);
  if (content == null) throw new Error(`${describe(target)} not found`);

  const lines = content.split('\n');
  const innerOf = (l) => l?.match(CHECKBOX)?.[3]?.trim();

  let idx = lineNo;
  if (innerOf(lines[idx]) !== raw) {
    idx = lines.findIndex((l) => innerOf(l) === raw);
  }
  if (idx < 0) throw new Error('task moved in note — sync and try again');

  const m = lines[idx].match(CHECKBOX);
  const mark = m[2].toLowerCase() === 'x' ? ' ' : 'x';
  lines[idx] = `${m[1]}- [${mark}] ${m[3]}`;
  await writeTarget(link, target, lines.join('\n'));
}

export async function searchVault(link, query) {
  const url = `${base(link)}/search/simple/?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { method: 'POST', headers: headers(link) });
  if (!res.ok) throw new Error(`search: ${res.status}`);
  return res.json();
}

export async function ping(link) {
  try {
    const res = await fetch(`${base(link)}/`, { headers: headers(link) });
    return res.ok;
  } catch {
    return false;
  }
}

// Local RAG: embeds tasks (for parse grounding) and the whole vault (for note
// answering) with nomic-embed-text, stored on disk as JSON. Retrieval is hybrid
// (vector + keyword fusion) with optional HyDE query expansion.
//
// INDEX_VERSION is stamped into each store; bump it whenever the embedding
// scheme changes (prefixes, chunk shape) so a stale index is rebuilt instead of
// silently mixing incompatible vectors.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { embed, embedBatch, complete } from './router.js';
import { collectAllTasks } from './tasks.js';
import { listFiles, vaultGet, searchSimple } from './obsidian.js';

const INDEX_VERSION = 2;
const DATA_DIR = path.resolve(process.cwd(), '.data');
const TASKS_STORE = path.join(DATA_DIR, 'tasks-index.json');
const NOTES_STORE = path.join(DATA_DIR, 'notes-index.json');

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function readStore<T>(file: string, empty: T): T {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.version === INDEX_VERSION) return j;
  } catch {
    /* missing or unreadable */
  }
  return empty;
}
function writeStore(file: string, data: any) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...data, version: INDEX_VERSION }));
  } catch {
    /* non-fatal */
  }
}

// ── tasks index ──────────────────────────────────────────────────────────────
interface TaskEntry {
  hash: string;
  title: string;
  project: string;
  vector: number[];
}
let tasks: { version?: number; entries: TaskEntry[] } = { entries: [] };
let tasksLoaded = false;
let centroids: { project: string; vector: number[] }[] | null = null;

function loadTasks() {
  if (tasksLoaded) return;
  tasks = readStore(TASKS_STORE, { entries: [] });
  tasksLoaded = true;
}

export async function reindexTasks(): Promise<{ count: number; embedded: number }> {
  loadTasks();
  const pulled = await collectAllTasks();
  const byHash = new Map(tasks.entries.map((e) => [e.hash, e]));
  const next: TaskEntry[] = [];
  const toEmbed: { idx: number; title: string; project: string; hash: string }[] = [];

  for (const t of pulled) {
    if (!t.title) continue;
    const h = hash(t.title + '|' + (t.project || 'none'));
    const existing = byHash.get(h);
    if (existing) {
      next.push(existing);
    } else {
      toEmbed.push({ idx: next.length, title: t.title, project: t.project || 'none', hash: h });
      next.push({ hash: h, title: t.title, project: t.project || 'none', vector: [] });
    }
  }

  if (toEmbed.length) {
    const vectors = await embedBatch(toEmbed.map((e) => e.title), 'document');
    toEmbed.forEach((e, i) => (next[e.idx].vector = vectors[i] ?? []));
  }

  tasks = { entries: next };
  centroids = null;
  writeStore(TASKS_STORE, { entries: next });
  return { count: next.length, embedded: toEmbed.length };
}

export async function similarTasks(
  text: string,
  k = 5,
): Promise<{ title: string; project: string; score: number }[]> {
  loadTasks();
  if (!tasks.entries.length) {
    try {
      await reindexTasks();
    } catch {
      return [];
    }
  }
  if (!tasks.entries.length) return [];
  let qv: number[];
  try {
    qv = await embed(text, 'query');
  } catch {
    return [];
  }
  return tasks.entries
    .map((e) => ({ title: e.title, project: e.project, score: cosine(qv, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// Average embedding per project — a cheap, stable classification prior.
function computeCentroids() {
  const groups = new Map<string, number[][]>();
  for (const e of tasks.entries) {
    if (!e.project || e.project === 'none' || !e.vector.length) continue;
    if (!groups.has(e.project)) groups.set(e.project, []);
    groups.get(e.project)!.push(e.vector);
  }
  centroids = [];
  for (const [project, vecs] of groups) {
    const dim = vecs[0].length;
    const mean = new Array(dim).fill(0);
    for (const v of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i];
    for (let i = 0; i < dim; i++) mean[i] /= vecs.length;
    centroids.push({ project, vector: mean });
  }
}

export async function nearestProject(text: string): Promise<{ project: string; score: number } | null> {
  loadTasks();
  if (!tasks.entries.length) return null;
  if (!centroids) computeCentroids();
  if (!centroids || !centroids.length) return null;
  let qv: number[];
  try {
    qv = await embed(text, 'query');
  } catch {
    return null;
  }
  let best: { project: string; score: number } | null = null;
  for (const c of centroids) {
    const score = cosine(qv, c.vector);
    if (!best || score > best.score) best = { project: c.project, score };
  }
  return best;
}

// ── whole-vault note index ───────────────────────────────────────────────────
interface NoteChunk {
  path: string;
  heading: string;
  display: string; // body for snippets
  vector: number[]; // embedded contextualized text
}
let notes: { version?: number; files: Record<string, string>; chunks: NoteChunk[] } = {
  files: {},
  chunks: [],
};
let notesLoaded = false;

function loadNotes() {
  if (notesLoaded) return;
  notes = readStore(NOTES_STORE, { files: {}, chunks: [] });
  notesLoaded = true;
}

// Chunk by heading, carrying the heading hierarchy + file path into the text we
// embed (but keeping the raw body for display).
function chunkNote(notePath: string, content: string): { heading: string; embedText: string; display: string }[] {
  const out: { heading: string; embedText: string; display: string }[] = [];
  const titleCtx = notePath.replace(/\.md$/i, '');
  let stack: { level: number; text: string }[] = [];
  let body: string[] = [];

  const flush = () => {
    const text = body.join('\n').trim();
    body = [];
    if (text.replace(/\s/g, '').length < 8 && stack.length === 0) return;
    const hp = stack.map((s) => s.text).join(' > ');
    const ctx = [titleCtx, hp].filter(Boolean).join(' > ');
    const embedText = (ctx + '\n' + text).slice(0, 1800);
    if (embedText.replace(/\s/g, '').length < 8) return;
    out.push({ heading: hp || '(top)', embedText, display: text.slice(0, 1800) });
  };

  for (const line of content.split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      stack = stack.filter((s) => s.level < level);
      stack.push({ level, text: h[2].trim() });
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

export async function reindexNotes(): Promise<{ files: number; chunks: number; embedded: number }> {
  loadNotes();
  const paths = await listFiles('');
  const nextFiles: Record<string, string> = {};
  const nextChunks: NoteChunk[] = [];
  const oldByPath = new Map<string, NoteChunk[]>();
  for (const c of notes.chunks) {
    if (!oldByPath.has(c.path)) oldByPath.set(c.path, []);
    oldByPath.get(c.path)!.push(c);
  }

  let embedded = 0;
  for (const p of paths) {
    let content: string | null;
    try {
      content = await vaultGet(p);
    } catch {
      continue;
    }
    if (content == null) continue;
    const h = hash(content);
    nextFiles[p] = h;

    if (notes.files[p] === h && oldByPath.has(p)) {
      nextChunks.push(...oldByPath.get(p)!);
      continue;
    }
    const chunks = chunkNote(p, content);
    if (!chunks.length) continue;
    const vectors = await embedBatch(chunks.map((c) => c.embedText), 'document');
    embedded += chunks.length;
    chunks.forEach((c, i) =>
      nextChunks.push({ path: p, heading: c.heading, display: c.display, vector: vectors[i] ?? [] }),
    );
  }

  notes = { files: nextFiles, chunks: nextChunks };
  writeStore(NOTES_STORE, { files: nextFiles, chunks: nextChunks });
  return { files: Object.keys(nextFiles).length, chunks: nextChunks.length, embedded };
}

// HyDE: draft a one-line hypothetical answer and fold it into the query so the
// embedding sits near real note prose rather than a vague question.
async function hyde(query: string): Promise<string> {
  try {
    const { text } = await complete(
      {
        system:
          'Write a single sentence that a note answering this question might contain. No preamble, just the sentence.',
        user: query,
      },
      'local',
    );
    return (query + '\n' + text).slice(0, 600);
  } catch {
    return query;
  }
}

export async function searchNotes(
  query: string,
  k = 4,
): Promise<{ path: string; heading: string; snippet: string; score: number }[]> {
  loadNotes();
  if (!notes.chunks.length) return [];

  const queryText = config.rag.hyde ? await hyde(query) : query;
  let qv: number[];
  try {
    qv = await embed(queryText, 'query');
  } catch {
    return [];
  }

  const scored = notes.chunks.map((c, i) => ({ i, score: cosine(qv, c.vector) }));
  const vecRank = [...scored].sort((a, b) => b.score - a.score);

  let order: number[];
  if (config.rag.hybrid) {
    // keyword side via Obsidian's built-in search → file ranks
    let kwFiles: string[] = [];
    try {
      const res = await searchSimple(query);
      kwFiles = (Array.isArray(res) ? res : []).map((r: any) => r.filename || r.path).filter(Boolean);
    } catch {
      /* keyword unavailable — fall back to vector only */
    }
    const kwRank = new Map<string, number>();
    kwFiles.forEach((f, idx) => kwRank.set(f, idx));

    const vrankOf = new Map<number, number>();
    vecRank.forEach((v, rank) => vrankOf.set(v.i, rank));

    const rrf = (rank: number) => 1 / (60 + rank);
    const fused = notes.chunks
      .map((c, i) => {
        let s = rrf(vrankOf.get(i) ?? 9999);
        if (kwRank.has(c.path)) s += rrf(kwRank.get(c.path)!);
        return { i, s };
      })
      .sort((a, b) => b.s - a.s);
    order = fused.map((f) => f.i);
  } else {
    order = vecRank.map((v) => v.i);
  }

  return order.slice(0, k).map((i) => ({
    path: notes.chunks[i].path,
    heading: notes.chunks[i].heading,
    snippet: notes.chunks[i].display.slice(0, 400),
    score: scored[i].score,
  }));
}

export function notesIndexSize(): number {
  loadNotes();
  return notes.chunks.length;
}

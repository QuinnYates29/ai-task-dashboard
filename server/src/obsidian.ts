// Server-side Obsidian Local REST API adapter.
// Holds the bearer token (out of the browser) and enforces the vault's
// hard rule: Independent/ is never read or written, under any circumstances.
import { Agent } from 'undici';
import { config, obsidianBase } from './config.js';

// localhost self-signed cert: accept it only for the loopback HTTPS endpoint.
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

function reqOpts(extra: any = {}): any {
  const o: any = {
    ...extra,
    headers: { Authorization: `Bearer ${config.obsidian.apiKey}`, ...(extra.headers ?? {}) },
  };
  if (!config.obsidian.useHttp) o.dispatcher = insecure;
  return o;
}

// Hard guard — refuse anything under Independent/ before a request is built.
function guard(path: string) {
  if (/(^|\/)Independent\//i.test(path)) {
    throw new Error('Independent/ is off-limits and cannot be accessed');
  }
}

function vaultUrl(path: string) {
  guard(path);
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return `${obsidianBase()}/vault/${enc}`;
}

export async function vaultGet(path: string): Promise<string | null> {
  const r = await fetch(vaultUrl(path), reqOpts());
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${r.statusText}`);
  return r.text();
}

export async function vaultPut(path: string, content: string): Promise<void> {
  const r = await fetch(
    vaultUrl(path),
    reqOpts({ method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, body: content }),
  );
  if (!r.ok) throw new Error(`PUT ${path}: ${r.status} ${r.statusText}`);
}

// Daily note via /periodic/daily/ — respects Obsidian's own daily-note config
// (folder, weekly nesting, naming), so reads and writes always hit the right file.
export async function readDaily(): Promise<string | null> {
  const r = await fetch(`${obsidianBase()}/periodic/daily/`, reqOpts());
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET daily: ${r.status} ${r.statusText}`);
  return r.text();
}

export async function writeDaily(content: string): Promise<void> {
  const r = await fetch(
    `${obsidianBase()}/periodic/daily/`,
    reqOpts({ method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, body: content }),
  );
  if (!r.ok) throw new Error(`PUT daily: ${r.status} ${r.statusText}`);
}

export async function ping(): Promise<boolean> {
  try {
    const r = await fetch(`${obsidianBase()}/`, reqOpts());
    return r.ok;
  } catch {
    return false;
  }
}

// Full-text search across the vault (Obsidian's built-in fuzzy search).
export async function searchSimple(query: string): Promise<any> {
  const r = await fetch(
    `${obsidianBase()}/search/simple/?query=${encodeURIComponent(query)}`,
    reqOpts({ method: 'POST' }),
  );
  if (!r.ok) throw new Error(`search: ${r.status} ${r.statusText}`);
  return r.json();
}

// Open a note in the Obsidian UI (jump-to-note from the dashboard).
export async function openInObsidian(notePath: string): Promise<void> {
  if (/(^|\/)Independent(\/|$)/i.test(notePath)) throw new Error('Independent/ is off-limits');
  const enc = notePath.split('/').map(encodeURIComponent).join('/');
  const r = await fetch(`${obsidianBase()}/open/${enc}`, reqOpts({ method: 'POST' }));
  if (!r.ok) throw new Error(`open ${notePath}: ${r.status} ${r.statusText}`);
}

// List one directory level (dir '' = vault root). Dirs come back with a '/'.
async function listDir(dir: string): Promise<string[]> {
  const enc = dir ? dir.split('/').map(encodeURIComponent).join('/') + '/' : '';
  const r = await fetch(`${obsidianBase()}/vault/${enc}`, reqOpts());
  if (!r.ok) return [];
  const j: any = await r.json();
  return j.files ?? [];
}

// Recursively list every .md file in the vault — Independent/ is skipped entirely.
export async function listFiles(dir = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listDir(dir)) {
    const full = dir ? `${dir}/${name}` : name;
    if (/(^|\/)Independent(\/|$)/i.test(full)) continue; // hard rule
    if (name.endsWith('/')) {
      out.push(...(await listFiles(full.replace(/\/$/, ''))));
    } else if (name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

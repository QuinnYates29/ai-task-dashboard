// Client for the Deck Server hub (server/). When the hub is reachable the app
// routes vault reads/writes and all AI through it; otherwise it falls back to
// the browser's direct Obsidian link.
//
// The hub address + auth token are resolved per-request from the active
// "endpoint profile" in localStorage, so switching where the dashboard points
// (Local → LAN → Remote) takes effect immediately, no reload. The token is sent
// as `Authorization: Bearer …` on every call — the server doesn't enforce it yet
// (see server/ TODO), but the wire format is ready for when it does.

const EP_KEY = 'deck.endpoints.v1';
const DEFAULT_URL = 'http://127.0.0.1:8787';

export const DEFAULT_ENDPOINTS = {
  activeId: 'local',
  profiles: [{ id: 'local', name: 'Local', url: DEFAULT_URL, token: '' }],
};

export function loadEndpoints() {
  try {
    const raw = JSON.parse(localStorage.getItem(EP_KEY));
    if (raw && Array.isArray(raw.profiles) && raw.profiles.length) return raw;
  } catch {
    /* ignore */
  }
  // Migrate a legacy single hub URL if the user set one before profiles existed.
  try {
    const legacy = localStorage.getItem('deck.hubUrl');
    if (legacy) return { activeId: 'local', profiles: [{ id: 'local', name: 'Local', url: legacy, token: '' }] };
  } catch {
    /* ignore */
  }
  return DEFAULT_ENDPOINTS;
}

export function saveEndpoints(ep) {
  try {
    localStorage.setItem(EP_KEY, JSON.stringify(ep));
  } catch {
    /* ignore */
  }
}

function activeProfile() {
  const ep = loadEndpoints();
  return ep.profiles.find((p) => p.id === ep.activeId) || ep.profiles[0] || DEFAULT_ENDPOINTS.profiles[0];
}

function hubUrl() {
  return (activeProfile().url || DEFAULT_URL).replace(/\/+$/, '');
}

function authHeaders(extra = {}) {
  const tok = activeProfile().token;
  return tok ? { Authorization: `Bearer ${tok}`, ...extra } : { ...extra };
}

async function jx(path, opts = {}) {
  const r = await fetch(hubUrl() + path, { ...opts, headers: authHeaders(opts.headers || {}) });
  if (!r.ok) {
    let msg;
    try {
      msg = (await r.json()).error;
    } catch {
      /* ignore */
    }
    throw new Error(msg || `${path}: ${r.status}`);
  }
  return r.json();
}

const JSON_POST = (body) => ({
  method: 'POST',
  headers: authHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify(body),
});

// Probe an arbitrary endpoint (used by the settings "Test connection" button,
// which needs to check a profile the user is editing but hasn't activated yet).
export async function getHealthAt(url, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const r = await fetch((url || '').replace(/\/+$/, '') + '/api/health', { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } finally {
    clearTimeout(t);
  }
}

// Health with a short timeout so the UI never hangs when the hub is down.
export async function getHealth() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    return await jx('/api/health', { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function getTasks() {
  return (await jx('/api/tasks')).tasks;
}

export async function getAllOpenTasks() {
  return (await jx('/api/tasks/all-open')).tasks;
}

export async function toggleTask(task) {
  return jx('/api/tasks/toggle', JSON_POST({ task }));
}

export async function chat(messages, projects, mode) {
  return jx('/api/ai/chat', JSON_POST({ messages, projects, mode }));
}

// Streaming chat over SSE. `onEvent` receives {type:'meta'|'delta'|'action'|'note'|'done'|'error', ...}.
export async function chatStream(messages, projects, mode, onEvent) {
  const r = await fetch(hubUrl() + '/api/ai/chat/stream', JSON_POST({ messages, projects, mode }));
  if (!r.ok || !r.body) {
    let msg;
    try {
      msg = (await r.json()).error;
    } catch {
      /* ignore */
    }
    throw new Error(msg || `chat stream: ${r.status}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch {
        /* skip malformed frame */
      }
    }
  }
}

export async function parse(text, projects, provider) {
  return jx('/api/ai/parse', JSON_POST({ text, projects, provider }));
}

export async function createTasks(tasks) {
  return jx('/api/tasks/create', JSON_POST({ tasks }));
}

export async function ingest(messages, projects, mode) {
  return jx('/api/ai/ingest', JSON_POST({ messages, projects, mode }));
}

export async function searchNotes(q, signal) {
  return (await (await fetch(`${hubUrl()}/api/search?q=${encodeURIComponent(q)}`, { signal, headers: authHeaders() })).json()).notes || [];
}

export async function openNote(path) {
  return jx('/api/notes/open', JSON_POST({ path }));
}

export async function getProjects() {
  return (await jx('/api/projects')).projects;
}

export async function addProject(p) {
  return (await jx('/api/projects', JSON_POST(p))).project;
}

export async function updateProject(id, patch) {
  return (
    await jx('/api/projects/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(patch),
    })
  ).project;
}

export async function removeProject(id) {
  return jx('/api/projects/' + encodeURIComponent(id), { method: 'DELETE' });
}

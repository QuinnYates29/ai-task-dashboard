// Client for the Deck Server hub (server/). When the hub is reachable the app
// routes vault reads/writes and all AI through it; otherwise it falls back to
// the browser's direct Obsidian link.

const HUB_URL = (() => {
  try {
    return localStorage.getItem('deck.hubUrl') || 'http://127.0.0.1:8787';
  } catch {
    return 'http://127.0.0.1:8787';
  }
})();

export { HUB_URL };

async function jx(path, opts = {}) {
  const r = await fetch(HUB_URL + path, opts);
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
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

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
  const r = await fetch(HUB_URL + '/api/ai/chat/stream', JSON_POST({ messages, projects, mode }));
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
  return (await (await fetch(`${HUB_URL}/api/search?q=${encodeURIComponent(q)}`, { signal })).json()).notes || [];
}

export async function openNote(path) {
  return jx('/api/notes/open', JSON_POST({ path }));
}

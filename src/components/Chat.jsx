import { useEffect, useRef, useState } from 'react';
import * as deck from '../lib/deck';

const MODES = ['local', 'auto', 'claude'];
// Local-only for now: the in-dashboard chat never calls Claude (no API credits).
// Edits/automation via Claude happen through the Mission Deck MCP server instead.
// Flip this to re-expose the local/auto/claude toggle.
const SHOW_MODE_TOGGLE = false;
const LOG_KEY = 'deck.chatLog';
const SUGGESTIONS = [
  "What's due today?",
  'What should I focus on next?',
  'Add a task to follow up with the team tomorrow',
  'Summarize my M7 tasks',
];

export default function Chat({ projects, claudeConfigured, onTasksChanged }) {
  // Persisted across tab switches and reloads so the chat doesn't reset when you
  // click into another view (Chat unmounts when you leave the tab).
  const [messages, setMessages] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LOG_KEY)) || [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(() => {
    if (!SHOW_MODE_TOGGLE) return 'local';
    try {
      return localStorage.getItem('deck.chatMode') || 'auto';
    } catch {
      return 'auto';
    }
  });
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!SHOW_MODE_TOGGLE) return;
    try {
      localStorage.setItem('deck.chatMode', mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  // Save the log whenever it changes (drop the transient streaming flag and any
  // empty in-flight assistant bubble).
  useEffect(() => {
    try {
      const clean = messages
        .filter((m) => m.content || (m.actions && m.actions.length))
        .map(({ streaming, ...m }) => m); // eslint-disable-line no-unused-vars
      localStorage.setItem(LOG_KEY, JSON.stringify(clean));
    } catch {
      /* ignore */
    }
  }, [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    const history = [...messages, { role: 'user', content }];
    // add the user turn + an empty assistant turn we stream into
    setMessages([...history, { role: 'assistant', content: '', actions: [], streaming: true }]);
    setInput('');
    setBusy(true);

    const wire = history.map((m) => ({ role: m.role, content: m.content }));
    let acted = false;

    // mutate the last (assistant) message as events arrive
    const patch = (fn) =>
      setMessages((msgs) => {
        const copy = msgs.slice();
        const i = copy.length - 1;
        copy[i] = fn({ ...copy[i] });
        return copy;
      });

    try {
      await deck.chatStream(wire, projects, mode, (e) => {
        if (e.type === 'meta') patch((m) => ({ ...m, provider: e.provider }));
        else if (e.type === 'delta') patch((m) => ({ ...m, content: m.content + e.text }));
        else if (e.type === 'action') {
          acted = true;
          patch((m) => ({ ...m, actions: [...(m.actions || []), { tool: e.tool, detail: e.detail }] }));
        } else if (e.type === 'note') patch((m) => ({ ...m, note: e.note }));
        else if (e.type === 'error') patch((m) => ({ ...m, provider: 'error', content: `⚠ ${e.error}` }));
      });
    } catch (err) {
      patch((m) => ({ ...m, provider: 'error', content: `⚠ ${err.message}` }));
    } finally {
      patch((m) => ({ ...m, streaming: false }));
      setBusy(false);
      if (acted) onTasksChanged?.();
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const saveToVault = async () => {
    if (!messages.length || busy) return;
    const wire = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'assistant', content: '', actions: [], streaming: true }]);
    setBusy(true);
    const finalize = (obj) =>
      setMessages((m) => {
        const c = m.slice();
        c[c.length - 1] = { role: 'assistant', actions: [], ...obj };
        return c;
      });
    try {
      const res = await deck.ingest(wire, projects, mode);
      finalize({ content: res.text, provider: res.provider, actions: res.actions || [], note: res.note });
      if (res.actions && res.actions.length) onTasksChanged?.();
    } catch (e) {
      finalize({ content: `⚠ ${e.message}`, provider: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat">
      <div className="chat-controls">
        {SHOW_MODE_TOGGLE ? (
          <>
            <div className="seg mode-seg">
              {MODES.map((m) => (
                <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)} title={modeHint(m)}>
                  {m}
                </button>
              ))}
            </div>
            {!claudeConfigured && mode !== 'local' && (
              <span className="ghost-note">Claude key not set — complex prompts stay local</span>
            )}
          </>
        ) : (
          <span className="ghost-note" title="The dashboard chat runs entirely on-device. Use the Mission Deck MCP server to drive tasks with Claude.">
            ○ Local · on-device
          </span>
        )}
        <div className="spacer" />
        {messages.length > 0 && (
          <>
            <button className="chat-save" onClick={saveToVault} disabled={busy} title="Summarize this chat and save it to the right note in your vault">
              ⤓ Save to vault
            </button>
            <button className="chat-clear" onClick={() => setMessages([])}>
              Clear
            </button>
          </>
        )}
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-glyph">◇</div>
            <div className="chat-empty-title">Ask A.L.F.R.E.D.</div>
            <div className="chat-empty-sub">
              Simple retrieval &amp; edits run locally; complex reasoning escalates to Claude.
            </div>
            <div className="chat-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === 'assistant' && m.provider && (
              <div className="bubble-meta">
                <span className={`prov prov-${m.provider}`}>
                  {m.provider === 'claude' ? '◆ Claude' : m.provider === 'error' ? '⚠ error' : '○ local'}
                </span>
                {(m.actions || []).map((a, j) => (
                  <span key={j} className="act-chip">
                    {actionLabel(a)}
                  </span>
                ))}
              </div>
            )}
            {m.role === 'assistant' && m.streaming && !m.content ? (
              <div className="thinking">
                <span /> <span /> <span /> A.L.F.R.E.D. is thinking…
              </div>
            ) : (
              <div className="bubble-body">
                {m.content}
                {m.streaming && m.content && <span className="caret" />}
              </div>
            )}
            {m.note && <div className="bubble-note">{m.note}</div>}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask anything, or tell A.L.F.R.E.D. to add / complete a task…"
          rows={1}
        />
        <button className="chat-send" onClick={() => send()} disabled={busy || !input.trim()}>
          ↑
        </button>
      </div>
    </div>
  );
}

function modeHint(m) {
  return m === 'local'
    ? 'Local only — nothing leaves your machine'
    : m === 'claude'
      ? 'Always use Claude'
      : 'Auto: simple → local, complex → Claude';
}

function actionLabel(a) {
  const verb =
    a.tool === 'create_task'
      ? '+ added'
      : a.tool === 'complete_task'
        ? '✓ done'
        : a.tool === 'search_vault'
          ? '⌕ searched'
          : a.tool === 'list_tasks'
            ? '◈ read tasks'
            : a.tool;
  return a.detail ? `${verb}: ${a.detail}` : verb;
}

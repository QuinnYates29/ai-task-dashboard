import { useEffect, useMemo, useRef, useState } from 'react';
import * as deck from '../lib/deck';

// Top-right menu trigger. For now it holds a single "Settings" action; the
// popover is built to take more items later (profile, about, sign-out, …).
export function SettingsMenu({ onOpenSettings }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc);
    return () => { window.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onEsc); };
  }, [open]);

  return (
    <div className="top-menu" ref={ref}>
      <button
        className={`top-menu-btn${open ? ' on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Menu"
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="tm-dots">⋯</span>
      </button>
      {open && (
        <div className="top-menu-pop" role="menu">
          <button
            className="top-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); onOpenSettings(); }}
          >
            <span className="tm-ico">⚙</span> Settings
          </button>
        </div>
      )}
    </div>
  );
}

const uid = () => 'ep' + Math.random().toString(36).slice(2, 8);

// A visual card. When `soon` is set the whole section is disabled + badged so
// it's clear the controls aren't wired up yet (kept visible on purpose so the
// roadmap is legible from the UI).
function Card({ title, desc, soon, children }) {
  return (
    <section className={`set-card${soon ? ' is-soon' : ''}`}>
      <div className="set-card-head">
        <div>
          <div className="set-card-title">{title}</div>
          {desc && <div className="set-card-desc">{desc}</div>}
        </div>
        {soon && <span className="soon-badge">Coming soon</span>}
      </div>
      <fieldset disabled={!!soon} className="set-card-body">{children}</fieldset>
    </section>
  );
}

export function SettingsPage({ onBack, hub, onEndpointsChanged }) {
  const [ep, setEp] = useState(() => deck.loadEndpoints());
  const [test, setTest] = useState(null); // { state:'testing'|'ok'|'err', health?, msg? }
  const [savedTick, setSavedTick] = useState('');

  const active = useMemo(
    () => ep.profiles.find((p) => p.id === ep.activeId) || ep.profiles[0],
    [ep],
  );

  // Persist + let the app re-probe the hub with the new target.
  const commit = (next, reprobe = true) => {
    setEp(next);
    deck.saveEndpoints(next);
    if (reprobe) onEndpointsChanged?.();
  };

  const switchTo = (id) => { setTest(null); commit({ ...ep, activeId: id }); };

  // Field edits stay local until "Save" so we don't poll half-typed URLs.
  const editActive = (patch) =>
    setEp((e) => ({ ...e, profiles: e.profiles.map((p) => (p.id === e.activeId ? { ...p, ...patch } : p)) }));

  const addProfile = () => {
    const id = uid();
    const n = ep.profiles.length + 1;
    const next = { activeId: id, profiles: [...ep.profiles, { id, name: `Endpoint ${n}`, url: '', token: '' }] };
    setTest(null);
    commit(next);
  };

  const removeProfile = (id) => {
    if (ep.profiles.length <= 1) return; // always keep at least one
    const profiles = ep.profiles.filter((p) => p.id !== id);
    const activeId = ep.activeId === id ? profiles[0].id : ep.activeId;
    commit({ activeId, profiles });
  };

  const save = () => {
    deck.saveEndpoints(ep);
    onEndpointsChanged?.();
    setSavedTick('Saved · dashboard now points here');
    setTimeout(() => setSavedTick(''), 2600);
  };

  const runTest = async () => {
    setTest({ state: 'testing' });
    try {
      const health = await deck.getHealthAt(active.url, active.token);
      setTest({ state: 'ok', health });
    } catch (e) {
      setTest({ state: 'err', msg: e.message });
    }
  };

  // Prefer the just-tested health; fall back to the app's live hub status.
  const health = test?.state === 'ok' ? test.health : hub;
  const row = (label, reachable, note) => (
    <div className="health-row">
      <span className={`health-dot ${reachable ? 'up' : 'down'}`} />
      <span className="health-label">{label}</span>
      <span className="health-note">{note}</span>
    </div>
  );

  return (
    <div className="set-page">
      <header className="set-head">
        <button className="set-back" onClick={onBack} aria-label="Back">‹ Back</button>
        <h1 className="set-title">Settings</h1>
      </header>

      <div className="set-body">
        {/* ── Connection / endpoints ─────────────────────────────── */}
        <Card
          title="Connection"
          desc="Where the dashboard reaches the Deck Server (the hub that proxies your vault + AI). Save endpoints for each place you host it and switch with one tap."
        >
          <div className="ep-tabs">
            {ep.profiles.map((p) => (
              <button
                key={p.id}
                className={`ep-tab${p.id === ep.activeId ? ' on' : ''}`}
                onClick={() => switchTo(p.id)}
                title={p.url || 'no URL set'}
              >
                {p.name || 'Untitled'}
              </button>
            ))}
            <button className="ep-tab ep-add" onClick={addProfile} title="Add endpoint">＋</button>
          </div>

          <div className="field">
            <label>Profile name</label>
            <input value={active.name} onChange={(e) => editActive({ name: e.target.value })} placeholder="Local / LAN / Remote" />
          </div>
          <div className="field">
            <label>Hub URL</label>
            <input
              value={active.url}
              onChange={(e) => editActive({ url: e.target.value })}
              placeholder="http://127.0.0.1:8787  ·  http://192.168.1.42:8787  ·  https://deck.example.com"
              autoComplete="off" spellCheck={false}
            />
          </div>
          <div className="field">
            <label>
              Auth token <span className="lbl-note">sent as Bearer — server enforcement coming</span>
            </label>
            <input
              type="password"
              value={active.token}
              onChange={(e) => editActive({ token: e.target.value })}
              placeholder="optional shared secret"
              autoComplete="off"
            />
          </div>

          {test && (
            <div className={`test-line ${test.state}`}>
              {test.state === 'testing' && 'Testing…'}
              {test.state === 'ok' && '✓ Reachable'}
              {test.state === 'err' && `✗ Could not reach hub — ${test.msg}`}
            </div>
          )}

          {health && (
            <div className="set-health">
              {row('Vault (Obsidian)', health.obsidian?.reachable, health.obsidian?.reachable ? health.obsidian.endpoint : health.obsidian?.configured ? 'configured, unreachable' : 'not configured')}
              {row('Local AI (Ollama)', health.ollama?.reachable, health.ollama?.reachable ? health.ollama.chatModel : 'offline')}
              {row('Claude', health.claude?.configured, health.claude?.configured ? health.claude.model : 'not configured')}
            </div>
          )}

          <div className="set-ops">
            <button className="btn" onClick={runTest}>Test connection</button>
            {ep.profiles.length > 1 && (
              <button className="btn danger" onClick={() => removeProfile(ep.activeId)}>Remove</button>
            )}
            <div className="spacer" />
            {savedTick && <span className="saved-tick">{savedTick}</span>}
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </Card>

        {/* ── Not-yet-wired settings, kept visible + greyed ──────── */}
        <Card title="AI" desc="Default model routing for chat and capture." soon>
          <div className="field">
            <label>Default AI mode</label>
            <select defaultValue="auto">
              <option value="local">Local only (Ollama)</option>
              <option value="auto">Auto (local first, Claude for hard tasks)</option>
              <option value="claude">Claude only</option>
            </select>
          </div>
        </Card>

        <Card title="Sync" desc="How often the dashboard polls the hub for changes." soon>
          <div className="field">
            <label>Poll interval</label>
            <select defaultValue="45">
              <option value="15">Every 15 seconds</option>
              <option value="45">Every 45 seconds</option>
              <option value="120">Every 2 minutes</option>
            </select>
          </div>
        </Card>

        <Card title="Display" desc="Wall-screen / kiosk appearance." soon>
          <div className="field">
            <label>Theme</label>
            <select defaultValue="command">
              <option value="command">Command Deck (dark)</option>
              <option value="highcontrast">High contrast</option>
            </select>
          </div>
        </Card>
      </div>
    </div>
  );
}

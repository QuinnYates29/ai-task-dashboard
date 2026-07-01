import { useEffect, useState } from 'react';
import { PALETTE } from '../lib/seed';
import { dueLabel } from '../lib/dates';
import * as deck from '../lib/deck';

function Veil({ onClose, children }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">{children}</div>
    </div>
  );
}

export function TaskSheet({ initial, projects, onSave, onClose }) {
  const [f, setF] = useState({
    title: initial?.title || '',
    notes: initial?.notes || '',
    project: initial?.project || '',
    priority: initial?.priority || 'medium',
    deadline: initial?.deadline || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <Veil onClose={onClose}>
      <div className="sheet-title">{initial ? 'Edit task' : 'New task'}</div>
      <div className="field">
        <label>Title</label>
        <input
          autoFocus
          value={f.title}
          onChange={set('title')}
          placeholder="What needs doing?"
          onKeyDown={(e) => e.key === 'Enter' && f.title.trim() && onSave(f)}
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label>Project</label>
          <select value={f.project} onChange={set('project')}>
            <option value="">No project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Priority</label>
          <select value={f.priority} onChange={set('priority')}>
            <option value="urgent">Urgent</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>Deadline</label>
        <input type="date" value={f.deadline} onChange={set('deadline')} />
      </div>
      <div className="field">
        <label>Notes</label>
        <textarea value={f.notes} onChange={set('notes')} placeholder="Context, links, details…" />
      </div>
      <div className="sheet-ops">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => f.title.trim() && onSave(f)}>
          {initial ? 'Save' : 'Add task'}
        </button>
      </div>
    </Veil>
  );
}

// Read-only detail popup opened by tapping a task card. Surfaces everything we
// know about a task plus quick actions. Edit/Delete only show for local tasks
// (vault tasks are edited in Obsidian); Complete/Reopen works for all.
export function TaskDetailSheet({ task, project, onToggle, onEdit, onDelete, onClose }) {
  const isVault = task.source === 'obsidian';
  const readonly = task.ob?.readonly;
  const rows = [
    ['Status', task.done ? '✓ Done' : '○ Open'],
    ['Project', project ? project.name : '—'],
    ['Priority', task.priority],
    ['Deadline', task.deadline ? dueLabel(task.deadline) : '—'],
    task.section ? ['Section', task.section] : null,
    ['Source', isVault ? (readonly ? 'Obsidian (display-only)' : 'Obsidian vault') : 'Local'],
    task.doneDate ? ['Completed', task.doneDate] : null,
  ].filter(Boolean);

  return (
    <Veil onClose={onClose}>
      <div className="detail-head">
        {project && <span className="detail-dot" style={{ background: project.color }} />}
        <div className="sheet-title" style={{ margin: 0 }}>{task.title}</div>
      </div>

      {task.notes && (
        <div className="field" style={{ marginBottom: 18 }}>
          <label>Notes</label>
          <div className="detail-notes">{task.notes}</div>
        </div>
      )}

      <div className="detail-grid">
        {rows.map(([k, v]) => (
          <div className="detail-row" key={k}>
            <label>{k}</label>
            <span className="detail-v">{v}</span>
          </div>
        ))}
      </div>

      <div className="sheet-ops">
        {!readonly && (
          <button className="btn primary" onClick={() => { onToggle(task); onClose(); }}>
            {task.done ? '↺ Reopen' : '✓ Complete'}
          </button>
        )}
        {!isVault && <button className="btn" onClick={() => onEdit(task)}>✎ Edit</button>}
        {!isVault && <button className="btn danger" onClick={() => { onDelete(task); onClose(); }}>✕ Delete</button>}
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Veil>
  );
}

export function ProjectsSheet({ projects, tasks, onAdd, onDelete, onRecolor, onClose }) {
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const add = () => {
    if (!name.trim()) return;
    onAdd(name.trim(), tag.trim());
    setName('');
    setTag('');
  };

  return (
    <Veil onClose={onClose}>
      <div className="sheet-title">Projects</div>
      <div className="hint">
        A project's <strong>tag</strong> is what links it to your tasks. Any vault
        task whose line carries that tag (e.g. <code>#robot</code>) is filed under
        this project automatically. Leave the tag blank for a manual-only project.
      </div>
      <div style={{ marginBottom: 16 }}>
        {projects.map((p) => (
          <div className="proj-row-edit" key={p.id}>
            <button
              className="pdot"
              style={{ background: p.color, width: 14, height: 14, borderRadius: 5 }}
              title="Cycle color"
              onClick={() => {
                const i = PALETTE.indexOf(p.color);
                onRecolor(p.id, PALETTE[(i + 1) % PALETTE.length]);
              }}
            />
            <span className="name">{p.name}</span>
            <span className="tag proj" style={{ background: p.color + '22', color: p.color }}>
              {p.tag || 'no tag'}
            </span>
            <span className="n">{tasks.filter((t) => t.project === p.id).length} tasks</span>
            <button className="op danger" onClick={() => onDelete(p.id)} title="Remove">✕</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ flex: 2 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name…"
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <input
          style={{ flex: 1 }}
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="#tag (optional)"
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn primary" onClick={add}>Add</button>
      </div>
      <div className="sheet-ops">
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    </Veil>
  );
}

// Create OR manage a single project. Opened for a NEW project (project == null)
// from the sidebar "+", or to manage an existing one from a project card.
export function ProjectSheet({ project, taskCount = 0, onCreate, onSave, onDelete, onOpen, onClose }) {
  const isNew = !project;
  const [f, setF] = useState({
    name: project?.name || '',
    tag: (project?.tag || '').replace(/^#/, ''),
    color: project?.color || PALETTE[0],
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = () => {
    if (!f.name.trim()) return;
    if (isNew) onCreate({ name: f.name.trim(), tag: f.tag, color: f.color });
    else onSave(project.id, { name: f.name.trim(), tag: f.tag, color: f.color });
    onClose();
  };
  const remove = () => {
    onDelete(project.id);
    onClose();
  };

  return (
    <Veil onClose={onClose}>
      <div className="sheet-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="pdot" style={{ background: f.color, width: 12, height: 12, borderRadius: 4 }} />
        {isNew ? 'New project' : 'Manage project'}
      </div>

      <div className="field">
        <label>Name</label>
        <input
          autoFocus
          value={f.name}
          onChange={set('name')}
          placeholder="Project name…"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="field">
        <label>Tag <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>vault tasks with this #tag file here</span></label>
        <input value={f.tag} onChange={set('tag')} placeholder="#tag (optional)" />
      </div>
      <div className="field">
        <label>Color</label>
        <div className="swatch-row">
          {PALETTE.map((c) => (
            <button
              key={c}
              className={`swatch${f.color === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => setF({ ...f, color: c })}
              title={c}
              aria-label={`Set color ${c}`}
            />
          ))}
        </div>
      </div>

      {!isNew && (
        <div className="hint">
          {taskCount} task{taskCount === 1 ? '' : 's'} filed here. Deleting keeps the tasks — they just lose the project label.
        </div>
      )}

      <div className="sheet-ops">
        {!isNew && <button className="btn danger" onClick={remove}>Delete</button>}
        {!isNew && <button className="btn" onClick={() => { onOpen(project.id); onClose(); }}>Open tasks →</button>}
        <div className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit}>{isNew ? 'Add project' : 'Save'}</button>
      </div>
    </Veil>
  );
}

export function LinkSheet({ link, status, onSave, onTest, onClose }) {
  const [f, setF] = useState({ ...link, files: link.files.join(', ') });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const build = () => ({
    ...f,
    files: f.files.split(',').map((s) => s.trim()).filter(Boolean),
  });

  const effectiveUrl = f.useHttp ? 'http://127.0.0.1:27123' : 'https://127.0.0.1:27124';

  return (
    <Veil onClose={onClose}>
      <div className="sheet-title">◈ Obsidian link</div>

      <div className="hint">
        Requires the <strong>Local REST API</strong> plugin in Obsidian. Your API key is under{' '}
        <code>Settings → Local REST API</code>. Tasks are pulled from the files below plus
        today's daily note every 45 s; completing a task writes the <code>[x]</code> back to
        the source note automatically.
      </div>

      {/* Enable toggle */}
      <div className="switch-row">
        <div>
          <div className="lbl">Enable live sync</div>
          <div className="sub">Pulls every 45 s while Obsidian is open</div>
        </div>
        <button
          className={`switch${f.enabled ? ' on' : ''}`}
          onClick={() => setF({ ...f, enabled: !f.enabled })}
          aria-label="Toggle Obsidian sync"
        />
      </div>

      {/* HTTP vs HTTPS */}
      <div className="switch-row">
        <div>
          <div className="lbl">Use plain HTTP <span style={{ color: 'var(--green)', fontSize: 11 }}>recommended</span></div>
          <div className="sub">
            {f.useHttp
              ? <>Port 27123 — no cert needed. Enable under <code>Settings → Local REST API → Enable HTTP server</code></>
              : <>Port 27124 HTTPS — must accept the self-signed cert in the browser once</>}
          </div>
        </div>
        <button
          className={`switch${f.useHttp ? ' on' : ''}`}
          onClick={() => setF({ ...f, useHttp: !f.useHttp })}
          aria-label="Toggle HTTP mode"
        />
      </div>

      <div className="hint" style={{ marginBottom: 14 }}>
        Connecting to: <code>{effectiveUrl}</code>
      </div>

      <div className="field">
        <label>API key</label>
        <input
          type="password"
          value={f.apiKey}
          onChange={set('apiKey')}
          placeholder="Paste from Settings → Local REST API"
          autoFocus
        />
      </div>
      <div className="field">
        <label>Task source files <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(comma-separated, relative to vault root)</span></label>
        <input value={f.files} onChange={set('files')} placeholder="DASHBOARD.md" />
      </div>
      <div className="field">
        <label>Daily notes folder <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(fallback if /periodic/daily/ has no Content-Location)</span></label>
        <input value={f.dailyFolder} onChange={set('dailyFolder')} placeholder="Daily Notes" />
      </div>

      {status && (
        <div className="hint" style={{ borderLeft: `3px solid ${status.startsWith('✓') ? 'var(--green)' : 'var(--coral)'}`, paddingLeft: 12 }}>
          {status}
        </div>
      )}

      <div className="sheet-ops">
        <button className="btn" onClick={() => onTest(build())}>Test connection</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(build())}>Save</button>
      </div>
    </Veil>
  );
}

export function CaptureSheet({ projects, onClose, onCreated, pop }) {
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState(null); // null = not parsed yet
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState('');

  const parse = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const res = await deck.parse(text.trim(), projects, 'auto');
      setProvider(res.provider);
      setDrafts((res.tasks || []).map((t) => ({ ...t, keep: true })));
      if (!res.tasks?.length) pop?.('nothing to capture — try rephrasing', '');
    } catch (e) {
      pop?.(`parse failed: ${e.message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const upd = (i, patch) => setDrafts((d) => d.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const commit = async () => {
    const kept = drafts.filter((t) => t.keep);
    if (!kept.length) return;
    setBusy(true);
    try {
      await deck.createTasks(kept);
      pop?.(`+ added ${kept.length} task${kept.length > 1 ? 's' : ''} to the vault`, 'good');
      onCreated?.();
      onClose();
    } catch (e) {
      pop?.(`write failed: ${e.message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Veil onClose={onClose}>
      <div className="sheet-title">✦ Capture</div>

      {!drafts ? (
        <>
          <div className="hint">
            Dump anything — emails, a brain-dump, half-thoughts. A.L.F.R.E.D. extracts tasks,
            picks projects (grounded in how you've filed similar tasks), and you approve before
            anything is written to the vault.
          </div>
          <div className="field">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. email liz the payroll letter by friday, and bring up the m7 scope timing next week"
              style={{ minHeight: 120 }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') parse();
              }}
            />
          </div>
          <div className="sheet-ops">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={parse} disabled={busy || !text.trim()}>
              {busy ? 'Reading…' : 'Extract tasks'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="hint">
            {drafts.length} task{drafts.length === 1 ? '' : 's'} found{' '}
            <span style={{ color: 'var(--text-3)' }}>· via {provider}</span>. Tweak, deselect, then add.
          </div>
          <div style={{ maxHeight: 360, overflowY: 'auto', marginBottom: 8 }}>
            {drafts.map((t, i) => (
              <div key={i} className={`cap-row${t.keep ? '' : ' off'}`}>
                <button
                  className={`tick${t.keep ? ' done' : ''}`}
                  style={{ width: 22, height: 22 }}
                  onClick={() => upd(i, { keep: !t.keep })}
                >
                  ✓
                </button>
                <div className="cap-fields">
                  <input value={t.title} onChange={(e) => upd(i, { title: e.target.value })} />
                  <div className="cap-meta">
                    <select value={t.project || 'none'} onChange={(e) => upd(i, { project: e.target.value })}>
                      <option value="none">no project</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <select value={t.priority} onChange={(e) => upd(i, { priority: e.target.value })}>
                      <option value="urgent">urgent</option>
                      <option value="medium">medium</option>
                      <option value="low">low</option>
                    </select>
                    <input type="date" value={t.deadline || ''} onChange={(e) => upd(i, { deadline: e.target.value })} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="sheet-ops">
            <button className="btn" onClick={() => setDrafts(null)}>← Back</button>
            <button className="btn primary" onClick={commit} disabled={busy || !drafts.some((t) => t.keep)}>
              {busy ? 'Writing…' : `Add ${drafts.filter((t) => t.keep).length} to vault`}
            </button>
          </div>
        </>
      )}
    </Veil>
  );
}

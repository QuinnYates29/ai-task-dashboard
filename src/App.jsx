import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { seedProjects, seedTasks, PALETTE } from './lib/seed';
import { todayISO, daysUntil, fmtLong } from './lib/dates';
import { DEFAULT_LINK, pullTasks, toggleTask as obToggle, ping } from './lib/obsidian';
import * as deck from './lib/deck';
import TaskCard from './components/TaskCard';
import Calendar from './components/Calendar';
import Chat from './components/Chat';
import NoteHits from './components/NoteHits';
import { TaskSheet, TaskDetailSheet, ProjectsSheet, ProjectSheet, LinkSheet, CaptureSheet } from './components/Sheets';
import { SettingsMenu, SettingsPage } from './components/Settings';

// v2: palette migrated to the A.L.F.R.E.D. theme — bumping keys reseeds project colors
// v3: added the OBD2 CAN Reader project to the seed set
const LS = {
  tasks: 'deck.tasks.v2',
  projects: 'deck.projects.v3',
  link: 'deck.link.v1',
  allLayout: 'deck.allLayout.v1',
  railOpen: 'deck.railOpen.v1',
  toolbarOpen: 'deck.toolbarOpen.v1',
  zoom: 'deck.zoom.v1',
};

const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.8;
const ZOOM_STEP = 0.1;
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

function loadLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const PRI_RANK = { urgent: 0, medium: 1, low: 2 };

function sortOpen(a, b) {
  const da = a.deadline ? daysUntil(a.deadline) : 9999;
  const db = b.deadline ? daysUntil(b.deadline) : 9999;
  if (da !== db) return da - db;
  return PRI_RANK[a.priority] - PRI_RANK[b.priority];
}

export default function App() {
  const [tasks, setTasks] = useState(() => loadLS(LS.tasks, seedTasks()));
  const [projects, setProjects] = useState(() => loadLS(LS.projects, seedProjects()));
  const [link, setLink] = useState(() => ({ ...DEFAULT_LINK, ...loadLS(LS.link, {}) }));
  const [obTasks, setObTasks] = useState([]);
  const [backlog, setBacklog] = useState([]); // all OPEN tasks across the whole vault (hub only)
  const [obState, setObState] = useState('off'); // off | live | err
  const [hub, setHub] = useState(null); // Deck Server health, or null if unreachable
  const [view, setView] = useState('today'); // today | all | done | calendar | projects | p:<id>
  const [query, setQuery] = useState('');
  const [priFilter, setPriFilter] = useState('all');
  const [projFilter, setProjFilter] = useState('all'); // all | none | <pid>  (All-tasks view)
  const [statusFilter, setStatusFilter] = useState('all'); // all | open | done  (All-tasks view)
  const [allLayout, setAllLayout] = useState(() => loadLS(LS.allLayout, 'list')); // list | board  (All-tasks layout)
  const [railOpen, setRailOpen] = useState(() => loadLS(LS.railOpen, true)); // left sidebar visible
  const [toolbarOpen, setToolbarOpen] = useState(() => loadLS(LS.toolbarOpen, true)); // search/filter bar visible
  const [zoom, setZoom] = useState(() => loadLS(LS.zoom, 1)); // content zoom for tasks/projects (kiosk readability)
  const [sheet, setSheet] = useState(null); // {kind:'task',task?} | {kind:'projects'} | {kind:'link'}
  const [linkStatus, setLinkStatus] = useState('');
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const now = useClock();

  useEffect(() => localStorage.setItem(LS.tasks, JSON.stringify(tasks)), [tasks]);
  useEffect(() => localStorage.setItem(LS.projects, JSON.stringify(projects)), [projects]);
  useEffect(() => localStorage.setItem(LS.link, JSON.stringify(link)), [link]);
  useEffect(() => localStorage.setItem(LS.allLayout, JSON.stringify(allLayout)), [allLayout]);
  useEffect(() => localStorage.setItem(LS.railOpen, JSON.stringify(railOpen)), [railOpen]);
  useEffect(() => localStorage.setItem(LS.toolbarOpen, JSON.stringify(toolbarOpen)), [toolbarOpen]);
  useEffect(() => localStorage.setItem(LS.zoom, JSON.stringify(zoom)), [zoom]);

  const bumpZoom = (delta) => setZoom((z) => clampZoom(Math.round((z + delta) * 10) / 10));

  // Latest zoom for gesture math, so listeners never need re-attaching.
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  const pinch = useRef({ startDist: 0, startZoom: 1 });

  // Native pinch / ctrl-wheel gestures on the content area. Attached via a
  // ref-callback so React 19 handles cleanup when the view (node) changes.
  // - trackpad pinch & ctrl+wheel → the browser sends wheel events with ctrlKey
  // - two-finger pinch on the touchscreen → touch events with 2 points
  // Plain wheel / one-finger drag are left alone so scrolling still works.
  const zoomGestureRef = useCallback((node) => {
    if (!node) return;
    const twoDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const d = Math.max(-0.12, Math.min(0.12, -e.deltaY * 0.01));
      setZoom((z) => clampZoom(z + d));
    };
    const onTouchStart = (e) => {
      if (e.touches.length === 2) pinch.current = { startDist: twoDist(e.touches), startZoom: zoomRef.current };
    };
    const onTouchMove = (e) => {
      if (e.touches.length === 2 && pinch.current.startDist > 0) {
        e.preventDefault();
        setZoom(clampZoom(pinch.current.startZoom * (twoDist(e.touches) / pinch.current.startDist)));
      }
    };
    const onTouchEnd = (e) => { if (e.touches.length < 2) pinch.current.startDist = 0; };
    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('touchstart', onTouchStart, { passive: false });
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', onTouchEnd);
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  const pop = (msg, mood = '') => {
    clearTimeout(toastTimer.current);
    setToast({ msg, mood });
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  // Settings is a full-page view; remember where we came from so "Back" returns.
  const prevViewRef = useRef('today');
  const openSettings = () => {
    if (view !== 'settings') prevViewRef.current = view;
    setView('settings');
  };
  const closeSettings = () => setView(prevViewRef.current || 'today');

  // ---- hub detection + project sync ----
  const useHubTasks = !!hub?.obsidian?.reachable;

  // A single probe of whatever endpoint is active. Passed to the settings page
  // so it can force an immediate re-check after switching endpoints.
  const refreshHub = useCallback(async () => {
    try {
      const h = await deck.getHealth();
      setHub(h);
      try {
        // Pull the authoritative project list from the server so add/remove
        // done in one browser session (or via Claude MCP) are reflected everywhere.
        setProjects(await deck.getProjects());
      } catch { /* hub up but projects endpoint failed — keep localStorage list */ }
    } catch {
      setHub(null);
    }
  }, []);

  useEffect(() => {
    refreshHub();
    const id = setInterval(refreshHub, 30000);
    return () => clearInterval(id);
  }, [refreshHub]);

  // ---- task sync (hub first, direct Obsidian link as fallback) ----
  const sync = useCallback(async (announce = false) => {
    if (useHubTasks) {
      try {
        const pulled = await deck.getTasks();
        setObTasks(pulled);
        setObState('live');
        if (announce) pop(`◈ pulled ${pulled.length} tasks from hub`, 'good');
      } catch (e) {
        setObState('err');
        if (announce) pop(`hub sync failed: ${e.message}`, 'bad');
      }
      try {
        setBacklog(await deck.getAllOpenTasks());
      } catch {
        /* backlog is best-effort — leave the last good list in place */
      }
      return;
    }
    setBacklog([]); // backlog is a hub-only feature
    if (!link.enabled || !link.apiKey) {
      setObTasks([]);
      setObState('off');
      return;
    }
    try {
      const pulled = await pullTasks(link, todayISO());
      setObTasks(pulled);
      setObState('live');
      if (announce) pop(`◈ pulled ${pulled.length} tasks from vault`, 'good');
    } catch (e) {
      setObState('err');
      if (announce) pop(`◈ sync failed: ${e.message}`, 'bad');
    }
  }, [useHubTasks, link]);

  useEffect(() => {
    sync();
    const id = setInterval(() => sync(), 45000);
    return () => clearInterval(id);
  }, [sync]);

  // Tasks from today's daily note + locally-added ones — the focused "today" set.
  // Project assignment is TAG-DRIVEN: a vault task belongs to whichever project's
  // tag (#fathom, #m7, …) appears on its line. The parser already resolves the
  // built-in projects, but a project ADDED on the dashboard needs its tag honored
  // too — so we re-classify here from the live projects list. We only fill in
  // tasks that aren't already on a known project (so we never override the
  // parser's specific-tag-wins choice), which lets a new project pick up any
  // vault task carrying its tag without touching the backend.
  const tagIndex = useMemo(() => {
    const m = {};
    for (const p of projects) {
      const tg = (p.tag || '').replace(/^#/, '').toLowerCase().trim();
      if (tg) m[tg] = p.id;
    }
    return m;
  }, [projects]);
  const projIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  const classify = useCallback(
    (t) => {
      if (t.source !== 'obsidian' || projIds.has(t.project)) return t;
      for (const tag of t.tags || []) {
        if (tagIndex[tag]) return { ...t, project: tagIndex[tag] };
      }
      return t;
    },
    [tagIndex, projIds],
  );

  const todayTasks = useMemo(() => [...obTasks, ...tasks].map(classify), [obTasks, tasks, classify]);
  const backlogTasks = useMemo(() => backlog.map(classify), [backlog, classify]);
  // Everything: today's set PLUS the whole-vault open backlog, deduped by title
  // (today's copy wins so toggles write to the daily note). This pool feeds All
  // tasks, the project views, Done, search, and every count — so a task living in
  // an older daily note is still visible and manageable everywhere, not just in
  // the backlog strip under Today.
  const all = useMemo(() => {
    const seen = new Set(todayTasks.map((t) => t.title.toLowerCase()));
    const extra = backlogTasks.filter((t) => !seen.has(t.title.toLowerCase()));
    return [...todayTasks, ...extra];
  }, [todayTasks, backlogTasks]);
  const projOf = (id) => projects.find((p) => p.id === id);

  // ---- mutations ----
  const toggle = async (task) => {
    if (task.source === 'obsidian') {
      if (task.ob?.readonly) {
        pop('logged in Obsidian — edit it there to change', '');
        return;
      }
      try {
        if (useHubTasks) await deck.toggleTask(task);
        else await obToggle(link, task);
        setObTasks((ts) =>
          ts.map((t) => (t.id === task.id ? { ...t, done: !t.done, doneDate: !t.done ? todayISO() : '' } : t))
        );
        // backlog holds only open tasks; checking one off drops it, by id or title
        setBacklog((ts) =>
          ts.filter((t) => t.id !== task.id && t.title.toLowerCase() !== task.title.toLowerCase())
        );
        pop(task.done ? 'reopened in vault' : '✓ checked off in vault', task.done ? '' : 'good');
      } catch (e) {
        pop(`vault write failed: ${e.message}`, 'bad');
      }
      return;
    }
    setTasks((ts) =>
      ts.map((t) => (t.id === task.id ? { ...t, done: !t.done, doneDate: !t.done ? todayISO() : '' } : t))
    );
    pop(task.done ? 'task reopened' : '✓ complete', task.done ? '' : 'good');
  };

  const saveTask = (form) => {
    if (sheet?.task) {
      setTasks((ts) => ts.map((t) => (t.id === sheet.task.id ? { ...t, ...form } : t)));
      pop('task updated', 'good');
    } else {
      setTasks((ts) => [
        { ...form, id: 'l' + Date.now(), done: false, doneDate: '', created: todayISO(), source: 'local' },
        ...ts,
      ]);
      pop('+ task added', 'good');
    }
    setSheet(null);
  };

  const removeTask = (task) => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    setTasks((ts) => ts.filter((t) => t.id !== task.id));
    pop('task deleted');
  };

  const addProject = async (name, tag = '', color) => {
    const clean = tag.replace(/^#/, '').toLowerCase().replace(/\s+/g, '-').trim();
    const finalColor = color || PALETTE[projects.length % PALETTE.length];
    const payload = { name, tag: clean, color: finalColor };
    if (useHubTasks) {
      try {
        const proj = await deck.addProject(payload);
        setProjects((ps) => ps.some((p) => p.id === proj.id) ? ps : [...ps, proj]);
        pop(`+ project “${proj.name}” added`, 'good');
      } catch (e) {
        pop(e.message, 'bad');
      }
    } else {
      const id = clean || 'p' + Date.now();
      setProjects((ps) => {
        if (ps.some((p) => p.id === id)) { pop('a project with that tag already exists', 'bad'); return ps; }
        return [...ps, { id, name, tag: clean ? '#' + clean : '', color: finalColor }];
      });
    }
  };

  const editProject = async (id, patch) => {
    const clean =
      patch.tag !== undefined
        ? patch.tag.replace(/^#/, '').toLowerCase().replace(/\s+/g, '-').trim()
        : undefined;
    if (useHubTasks) {
      try {
        const proj = await deck.updateProject(id, { ...patch, ...(clean !== undefined ? { tag: clean } : {}) });
        setProjects((ps) => ps.map((p) => (p.id === proj.id ? proj : p)));
        pop('project updated', 'good');
      } catch (e) {
        pop(e.message, 'bad');
      }
    } else {
      setProjects((ps) =>
        ps.map((p) =>
          p.id === id
            ? { ...p, ...patch, ...(clean !== undefined ? { tag: clean ? '#' + clean : '' } : {}) }
            : p,
        ),
      );
      pop('project updated', 'good');
    }
  };

  const deleteProject = async (id) => {
    if (!confirm('Remove project? Its tasks move to “no project”.')) return;
    if (useHubTasks) {
      try {
        await deck.removeProject(id);
        setProjects((ps) => ps.filter((p) => p.id !== id));
        setTasks((ts) => ts.map((t) => (t.project === id ? { ...t, project: '' } : t)));
        if (view === 'p:' + id) setView('all');
        pop('project removed', '');
      } catch (e) {
        pop(e.message, 'bad');
      }
    } else {
      setProjects((ps) => ps.filter((p) => p.id !== id));
      setTasks((ts) => ts.map((t) => (t.project === id ? { ...t, project: '' } : t)));
      if (view === 'p:' + id) setView('all');
    }
  };

  // ---- filtering ----
  const matchesToolbar = (t, q) =>
    (priFilter === 'all' || t.priority === priFilter) &&
    (!q || t.title.toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q));
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return all.filter((t) => matchesToolbar(t, q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, query, priFilter]);
  // Today's view stays scoped to the daily note; the vault backlog renders as its
  // own section below rather than flooding the top sections.
  const todayFiltered = useMemo(() => {
    const q = query.toLowerCase();
    return todayTasks.filter((t) => matchesToolbar(t, q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayTasks, query, priFilter]);

  const open = all.filter((t) => !t.done);
  const urgentN = open.filter((t) => t.priority === 'urgent').length;
  const dueTodayN = open.filter((t) => t.deadline && daysUntil(t.deadline) <= 0).length;
  const doneTodayN = all.filter((t) => t.done && t.doneDate === todayISO()).length;

  const cardProps = {
    onToggle: toggle,
    onEdit: (t) => setSheet({ kind: 'task', task: t }),
    onDelete: removeTask,
    onJumpProject: (id) => setView('p:' + id),
    onOpen: (t) => setSheet({ kind: 'detail', task: t }),
  };

  const titleFor = () =>
    view === 'today' ? 'Today' :
    view === 'all' ? 'All tasks' :
    view === 'done' ? 'Done' :
    view === 'chat' ? 'Chat' :
    view === 'calendar' ? 'Calendar' :
    view === 'projects' ? 'Projects' :
    projOf(view.slice(2))?.name || 'Tasks';

  // ---- view renderers ----
  const renderStack = (list, emptyLine, emptySub) =>
    list.length ? (
      <div className="stack">
        {list.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}
      </div>
    ) : (
      <div className="void">
        <div className="void-glyph">✓</div>
        <div className="void-line">{emptyLine}</div>
        <div className="void-sub">{emptySub}</div>
      </div>
    );

  const band = (label, count, color) => (
    <div className="band">
      <span className="band-tag">
        {color && <span className="pdot" style={{ background: color }} />}
        {label}
      </span>
      <div className="band-rule" />
      <span className="band-n">{count}</span>
    </div>
  );

  const renderToday = () => {
    const openF = todayFiltered.filter((t) => !t.done);
    const overdue = openF.filter((t) => t.deadline && daysUntil(t.deadline) < 0).sort(sortOpen);
    const due = openF.filter((t) => t.deadline && daysUntil(t.deadline) === 0).sort(sortOpen);
    const radar = openF
      .filter((t) => !t.deadline || daysUntil(t.deadline) > 0)
      .sort(sortOpen)
      .slice(0, 8);
    const doneToday = todayFiltered.filter((t) => t.done && t.doneDate === todayISO());

    // Cross-vault backlog: every open task in the vault that isn't already on
    // today's board (matched by title), grouped by project. Honors the toolbar
    // search/priority filters so the section narrows with everything else.
    const q = query.toLowerCase();
    const shownTitles = new Set(openF.map((t) => t.title.toLowerCase()));
    const backlogOpen = backlogTasks
      .filter((t) => !shownTitles.has(t.title.toLowerCase()))
      .filter((t) => priFilter === 'all' || t.priority === priFilter)
      .filter((t) => !q || t.title.toLowerCase().includes(q));
    const backlogGroups = projects
      .map((p) => ({ p, items: backlogOpen.filter((t) => t.project === p.id).sort(sortOpen) }))
      .filter((g) => g.items.length);
    const backlogNone = backlogOpen.filter((t) => !projOf(t.project)).sort(sortOpen);

    if (!overdue.length && !due.length && !radar.length && !doneToday.length && !backlogOpen.length) {
      return renderStack([], 'Clear deck', 'Nothing on the board — add a task or sync your vault.');
    }
    const renderBacklog = () =>
      backlogOpen.length > 0 && (
        <>
          {band('Backlog · whole vault', backlogOpen.length, 'var(--violet)')}
          {backlogGroups.map(({ p, items }) => (
            <div key={p.id} className="backlog-group">
              <div className="backlog-group-head" style={{ color: p.color }}>◆ {p.name}</div>
              <div className="stack">
                {items.map((t) => <TaskCard key={t.id} task={t} project={p} {...cardProps} />)}
              </div>
            </div>
          ))}
          {backlogNone.length > 0 && (
            <div className="backlog-group">
              <div className="backlog-group-head" style={{ color: 'var(--text-3)' }}>◇ No project</div>
              <div className="stack">
                {backlogNone.map((t) => <TaskCard key={t.id} task={t} project={undefined} {...cardProps} />)}
              </div>
            </div>
          )}
        </>
      );
    return (
      <>
        {overdue.length > 0 && (
          <>
            {band('Overdue', overdue.length, 'var(--coral)')}
            <div className="stack">{overdue.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}</div>
          </>
        )}
        {due.length > 0 && (
          <>
            {band('Due today', due.length, 'var(--acc)')}
            <div className="stack">{due.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}</div>
          </>
        )}
        {radar.length > 0 && (
          <>
            {band('On the radar', radar.length, 'var(--teal)')}
            <div className="stack">{radar.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}</div>
          </>
        )}
        {doneToday.length > 0 && (
          <>
            {band('Done today', doneToday.length, 'var(--green)')}
            <div className="stack">{doneToday.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}</div>
          </>
        )}
        {renderBacklog()}
      </>
    );
  };

  // base list for the All view, after the toolbar's project + status filters
  const allScoped = useMemo(() => {
    return filtered.filter((t) => {
      if (projFilter === 'none' && t.project && projOf(t.project)) return false;
      if (projFilter !== 'all' && projFilter !== 'none' && t.project !== projFilter) return false;
      if (statusFilter === 'open' && t.done) return false;
      if (statusFilter === 'done' && !t.done) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, projFilter, statusFilter]);

  const renderAll = () => {
    const openF = allScoped.filter((t) => !t.done);
    const doneF = allScoped.filter((t) => t.done);
    const noProj = openF.filter((t) => !t.project || !projOf(t.project)).sort(sortOpen);

    // Board layout: one column per project (plus an Inbox column for unfiled
    // tasks), open tasks first then done. Honors the toolbar's project/status
    // filters via allScoped.
    if (allLayout === 'board') {
      const inBoard = (t) => (t.done ? 1 : 0) - 0;
      const colSort = (a, b) => inBoard(a) - inBoard(b) || sortOpen(a, b);
      const inbox = allScoped.filter((t) => !t.project || !projOf(t.project));
      const cols = [];
      if (inbox.length) cols.push({ id: 'none', name: 'Inbox', color: 'var(--text-3)', proj: null, tasks: inbox });
      projects.forEach((p) => {
        const list = allScoped.filter((t) => t.project === p.id);
        if (list.length) cols.push({ id: p.id, name: p.name, color: p.color, proj: p, tasks: list });
      });
      if (!cols.length) return renderStack([], 'Nothing matches', 'Try a different filter.');
      return (
        <div className="board">
          {cols.map((c) => (
            <div className="board-col" key={c.id}>
              <div className="board-col-head" style={{ '--col': c.color }}>
                <span className="board-col-name">{c.name}</span>
                <span className="board-col-count">{c.tasks.length}</span>
              </div>
              <div className="board-col-body">
                {c.tasks.slice().sort(colSort).map((t) => (
                  <TaskCard key={t.id} task={t} project={c.proj} {...cardProps} />
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    }

    // When a single project is selected the per-project banding is noise — flat list.
    const flat = projFilter !== 'all';

    if (flat) {
      const openSorted = openF.sort(sortOpen);
      return (
        <>
          {openSorted.length > 0 && (
            <>
              {band('Open', openSorted.length)}
              <div className="stack">{openSorted.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}</div>
            </>
          )}
          {doneF.length > 0 && (
            <>
              {band('Completed', doneF.length)}
              <div className="stack">{doneF.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}</div>
            </>
          )}
          {!openSorted.length && !doneF.length && renderStack([], 'Nothing matches', 'Try a different filter.')}
        </>
      );
    }

    return (
      <>
        {noProj.length > 0 && (
          <>
            {band('Inbox', noProj.length)}
            <div className="stack">{noProj.map((t) => <TaskCard key={t.id} task={t} project={null} {...cardProps} />)}</div>
          </>
        )}
        {projects.map((p) => {
          const list = openF.filter((t) => t.project === p.id).sort(sortOpen);
          if (!list.length) return null;
          return (
            <div key={p.id}>
              {band(p.name, list.length, p.color)}
              <div className="stack">{list.map((t) => <TaskCard key={t.id} task={t} project={p} {...cardProps} />)}</div>
            </div>
          );
        })}
        {doneF.length > 0 && (
          <>
            {band('Completed', doneF.length)}
            <div className="stack">{doneF.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}</div>
          </>
        )}
        {!openF.length && !doneF.length && renderStack([], 'Nothing here', 'Add a task to get rolling.')}
      </>
    );
  };

  const renderDone = () => {
    const done = filtered
      .filter((t) => t.done)
      .sort((a, b) => (b.doneDate || '').localeCompare(a.doneDate || '') || a.title.localeCompare(b.title));
    const todays = done.filter((t) => t.doneDate === todayISO());
    const earlier = done.filter((t) => t.doneDate !== todayISO());

    if (!done.length) {
      return renderStack([], 'Nothing done yet', 'Completed tasks — checked items and your daily-note Done section — land here.');
    }
    return (
      <>
        {todays.length > 0 && (
          <>
            {band('Done today', todays.length, 'var(--green)')}
            <div className="stack">{todays.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}</div>
          </>
        )}
        {earlier.length > 0 && (
          <>
            {band('Earlier', earlier.length)}
            <div className="stack">{earlier.map((t) => <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />)}</div>
          </>
        )}
      </>
    );
  };

  const renderProject = (pid) => {
    const p = projOf(pid);
    const list = filtered.filter((t) => t.project === pid);
    const openL = list.filter((t) => !t.done).sort(sortOpen);
    const doneL = list.filter((t) => t.done);
    return (
      <>
        {band('Open', openL.length, p?.color)}
        {renderStack(openL, 'All clear', 'No open tasks in this project.')}
        {doneL.length > 0 && (
          <>
            {band('Completed', doneL.length)}
            <div className="stack">{doneL.map((t) => <TaskCard key={t.id} task={t} project={p} {...cardProps} />)}</div>
          </>
        )}
      </>
    );
  };

  const renderProjects = () => (
    <div className="proj-grid">
      {projects.map((p) => {
        const list = all.filter((t) => t.project === p.id);
        const openL = list.filter((t) => !t.done);
        const doneN = list.length - openL.length;
        const pct = list.length ? Math.round((doneN / list.length) * 100) : 0;
        const urg = openL.filter((t) => t.priority === 'urgent').length;
        return (
          <div key={p.id} className="proj-card" style={{ '--edge': p.color }} onClick={() => setSheet({ kind: 'project', project: p })}>
            <div className="proj-head">
              <div>
                <div className="proj-name">{p.name}</div>
                {p.tag && <div className="proj-tag-mono">{p.tag}</div>}
              </div>
              {urg ? <span className="urgent-pill">{urg} urgent</span> : <span className="open-pill">{openL.length} open</span>}
            </div>
            <div className="proj-stat-line">{openL.length} open · {doneN} done · {pct}%</div>
            <div className="meter"><div className="meter-fill" style={{ width: pct + '%', background: p.color }} /></div>
            <div className="proj-peek">
              {openL.sort(sortOpen).slice(0, 3).map((t) => (
                <div key={t.id} className="peek">
                  <span className="mini" style={{ background: t.priority === 'urgent' ? 'var(--coral)' : t.priority === 'medium' ? 'var(--acc)' : 'var(--text-3)' }} />
                  {t.title}
                </div>
              ))}
              {openL.length > 3 && <div className="peek" style={{ color: p.color }}>+ {openL.length - 3} more</div>}
            </div>
          </div>
        );
      })}
    </div>
  );

  // ---- link sheet handlers ----
  const testLink = async (cfg) => {
    setLinkStatus('Testing…');
    try {
      const ok = await ping(cfg);
      setLinkStatus(ok ? '✓ Connected — Obsidian REST API is reachable.' : '✗ Server responded but not OK — check the API key.');
    } catch (e) {
      setLinkStatus(`✗ Could not reach ${cfg.baseUrl}. Is the plugin running? Has the self-signed cert been accepted in this browser? (${e.message})`);
    }
  };

  const hour = now.getHours();
  const greeting = hour < 5 ? 'Night shift' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const hubStatus = hub
    ? hub.obsidian.reachable
      ? { cls: 'live', label: 'hub · vault linked' }
      : { cls: 'err', label: 'hub up · vault off' }
    : obState === 'live'
      ? { cls: 'live', label: 'vault linked (direct)' }
      : obState === 'err'
        ? { cls: 'err', label: 'vault unreachable' }
        : { cls: '', label: 'hub offline' };

  return (
    <div className={`deck${railOpen ? '' : ' rail-collapsed'}`}>
      <aside className="rail">
        <div className="rail-brand">
          <div className="rail-brand-name"><span className="beacon" />Mission Deck</div>
          <div className="rail-brand-sub">quinn · {todayISO()}</div>
        </div>

        <div className="rail-group">
          <div className="rail-label">Views</div>
          {[
            ['today', 'Today', open.filter((t) => t.deadline && daysUntil(t.deadline) <= 0).length],
            ['all', 'All tasks', open.length],
            ['done', 'Done', all.filter((t) => t.done).length],
            ['chat', 'Chat', null],
            ['calendar', 'Calendar', null],
            ['projects', 'Projects', projects.length],
          ].map(([id, label, n]) => (
            <button key={id} className={`rail-item${view === id ? ' on' : ''}`} onClick={() => setView(id)}>
              <div className="rail-item-left"><span>{label}</span></div>
              {n != null && <span className="rail-count">{n}</span>}
            </button>
          ))}
        </div>

        <div className="rail-group">
          <div className="rail-label-row">
            <span className="rail-label">Projects</span>
            <button
              className="rail-add"
              onClick={() => setSheet({ kind: 'project', project: null })}
              title="New project"
              aria-label="New project"
            >+</button>
          </div>
          {projects.map((p) => (
            <div key={p.id} className="rail-item-wrap">
              <button className={`rail-item${view === 'p:' + p.id ? ' on' : ''}`} onClick={() => setView('p:' + p.id)}>
                <div className="rail-item-left">
                  <span className="pdot" style={{ background: p.color }} />
                  <span>{p.name}</span>
                </div>
                <span className="rail-count">{all.filter((t) => !t.done && t.project === p.id).length}</span>
              </button>
              <button
                className="rail-del"
                onClick={() => deleteProject(p.id)}
                title={`Delete ${p.name}`}
                aria-label={`Delete project ${p.name}`}
              >×</button>
            </div>
          ))}
        </div>

        <div className="rail-foot">
          <button className="rail-btn primary" onClick={() => setSheet({ kind: 'task' })}>+ New task</button>
          <button className="rail-btn" onClick={() => setSheet({ kind: 'capture' })}>✦ Capture</button>
          <button className="rail-btn" onClick={() => setSheet({ kind: 'projects' })}>⊞ Projects</button>
          <button className="rail-btn" onClick={() => { setLinkStatus(''); setSheet({ kind: 'link' }); }}>◈ Obsidian link</button>
          {(useHubTasks || link.enabled) && (
            <button className="rail-btn" onClick={() => sync(true)}>⟳ Sync now</button>
          )}
          <div className={`link-state ${hubStatus.cls}`}>
            <span className="dot" />
            {hubStatus.label}
          </div>
        </div>
      </aside>

      {/* Always-present, vertically-centered edge tab: collapses the rail when
          open, brings it back when closed. Fixed, so it never scrolls away. */}
      <button
        className={`rail-toggle${railOpen ? '' : ' is-collapsed'}`}
        onClick={() => setRailOpen((o) => !o)}
        title={railOpen ? 'Minimize sidebar' : 'Show sidebar'}
        aria-label={railOpen ? 'Minimize sidebar' : 'Show sidebar'}
      >
        {railOpen ? '‹' : '›'}
      </button>

      <main className="stage">
        {/* Compact nav for small screens (the rail is hidden under 760px). */}
        <nav className="mobile-nav">
          <span className="mobile-brand"><span className="beacon" />Deck</span>
          {[['today', 'Today'], ['all', 'All'], ['done', 'Done'], ['chat', 'Chat'], ['calendar', 'Cal'], ['projects', 'Projects']].map(([id, label]) => (
            <button key={id} className={`mobile-tab${view === id || (id === 'projects' && view.startsWith('p:')) ? ' on' : ''}`} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
          <button className="mobile-tab add" onClick={() => setSheet({ kind: 'task' })}>＋</button>
          <SettingsMenu onOpenSettings={openSettings} />
        </nav>

        {view === 'settings' ? (
          <SettingsPage
            onBack={closeSettings}
            hub={hub}
            onEndpointsChanged={() => { refreshHub(); sync(); }}
          />
        ) : (
        <>
        <header className="masthead">
          <div className="mast-left">
            <span className="mast-kicker">{greeting} · {fmtLong(todayISO())}</span>
            <h1 className="mast-title">{titleFor()}</h1>
          </div>
          <div className="mast-right">
            <div className="gauges">
              <div className="gauge"><div className="gauge-val">{open.length}</div><div className="gauge-cap">Open</div></div>
              <div className="gauge"><div className={`gauge-val${urgentN ? ' hot' : ''}`}>{urgentN}</div><div className="gauge-cap">Urgent</div></div>
              <div className="gauge"><div className={`gauge-val${dueTodayN ? ' warm' : ''}`}>{dueTodayN}</div><div className="gauge-cap">Due now</div></div>
              <div className="gauge"><div className={`gauge-val${doneTodayN ? ' cool' : ''}`}>{doneTodayN}</div><div className="gauge-cap">Done</div></div>
            </div>
            <div className="clock">
              <div className="clock-time">
                {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/ (AM|PM)/, '')}
                <small>{now.getHours() >= 12 ? 'PM' : 'AM'}</small>
              </div>
              <div className="clock-date">{now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
            </div>
            <SettingsMenu onOpenSettings={openSettings} />
          </div>
        </header>

        {view !== 'projects' && view !== 'calendar' && view !== 'chat' && !toolbarOpen && (
          <button className="toolbar-show" onClick={() => setToolbarOpen(true)} title="Show search & filters">
            ⌕ Search & filters
          </button>
        )}

        {view !== 'projects' && view !== 'calendar' && view !== 'chat' && toolbarOpen && (
          <div className="toolbar">
            <div className="search">
              <span className="glyph">⌕</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks…" />
            </div>
            <div className="seg">
              {['all', 'urgent', 'medium', 'low'].map((p) => (
                <button key={p} className={priFilter === p ? 'on' : ''} onClick={() => setPriFilter(p)}>
                  {p === 'all' ? 'All' : p}
                </button>
              ))}
            </div>
            {view === 'all' && (
              <>
                <select className="filter" value={projFilter} onChange={(e) => setProjFilter(e.target.value)} title="Filter by project">
                  <option value="all">All projects</option>
                  <option value="none">No project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select className="filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} title="Filter by status">
                  <option value="all">Any status</option>
                  <option value="open">Open</option>
                  <option value="done">Done</option>
                </select>
                <div className="seg">
                  <button className={allLayout === 'list' ? 'on' : ''} onClick={() => setAllLayout('list')} title="List view">☰ List</button>
                  <button className={allLayout === 'board' ? 'on' : ''} onClick={() => setAllLayout('board')} title="Board view — columns by project">▦ Board</button>
                </div>
              </>
            )}
            <div className="spacer" />
            {link.enabled && obState === 'live' && (
              <span className="ghost-note">◈ {obTasks.length} from vault · refreshes 45s</span>
            )}
            <button className="toolbar-collapse" onClick={() => setToolbarOpen(false)} title="Minimize search & filters" aria-label="Minimize search bar">▴</button>
          </div>
        )}

        {view === 'chat' ? (
          <Chat
            projects={projects}
            claudeConfigured={!!hub?.claude?.configured}
            onTasksChanged={() => { sync(); refreshHub(); }}
          />
        ) : (
          <div className="scroll" style={{ zoom }} ref={zoomGestureRef}>
            {query.trim() && useHubTasks && (view === 'today' || view === 'all' || view === 'done' || view.startsWith('p:')) && (
              <NoteHits query={query} />
            )}
            {view === 'today' && renderToday()}
            {view === 'all' && renderAll()}
            {view === 'done' && renderDone()}
            {view === 'calendar' && <Calendar tasks={all} projects={projects} cardProps={cardProps} />}
            {view === 'projects' && renderProjects()}
            {view.startsWith('p:') && renderProject(view.slice(2))}
          </div>
        )}

        {view !== 'chat' && (
          <div className="zoom-dock" role="group" aria-label="Zoom tasks and projects">
            <button className="zoom-btn" onClick={() => bumpZoom(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} title="Zoom out" aria-label="Zoom out">−</button>
            <button className="zoom-pct" onClick={() => setZoom(1)} title="Reset zoom to 100%" aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
            <button className="zoom-btn" onClick={() => bumpZoom(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} title="Zoom in" aria-label="Zoom in">+</button>
          </div>
        )}
        </>
        )}
      </main>

      {sheet?.kind === 'task' && (
        <TaskSheet initial={sheet.task} projects={projects} onSave={saveTask} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === 'detail' && (
        <TaskDetailSheet
          task={sheet.task}
          project={projOf(sheet.task.project)}
          onToggle={toggle}
          onEdit={(t) => setSheet({ kind: 'task', task: t })}
          onDelete={removeTask}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'capture' && (
        <CaptureSheet
          projects={projects}
          pop={pop}
          onCreated={() => sync()}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'projects' && (
        <ProjectsSheet
          projects={projects}
          tasks={all}
          onAdd={addProject}
          onDelete={deleteProject}
          onRecolor={(id, color) => editProject(id, { color })}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'project' && (
        <ProjectSheet
          project={sheet.project}
          taskCount={sheet.project ? all.filter((t) => t.project === sheet.project.id).length : 0}
          onCreate={(p) => addProject(p.name, p.tag, p.color)}
          onSave={editProject}
          onDelete={deleteProject}
          onOpen={(id) => setView('p:' + id)}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'link' && (
        <LinkSheet
          link={link}
          status={linkStatus}
          onTest={testLink}
          onSave={(cfg) => { setLink(cfg); setSheet(null); if (cfg.enabled) sync(cfg, true); }}
          onClose={() => setSheet(null)}
        />
      )}

      {toast && <div className={`toast ${toast.mood}`}>{toast.msg}</div>}
    </div>
  );
}

import { useState } from 'react';
import { localISO, todayISO, fmtLong } from '../lib/dates';
import TaskCard from './TaskCard';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Calendar({ tasks, projects, cardProps }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [selected, setSelected] = useState(todayISO());

  const projOf = (id) => projects.find((p) => p.id === id);

  const byDay = {};
  for (const t of tasks) {
    if (!t.deadline) continue;
    (byDay[t.deadline] ??= []).push(t);
  }

  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });

  const step = (dir) => {
    let m = month + dir;
    let y = year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setMonth(m);
    setYear(y);
  };

  const goToday = () => {
    setYear(now.getFullYear());
    setMonth(now.getMonth());
    setSelected(todayISO());
  };

  const dayTasks = (byDay[selected] || []).sort((a, b) => a.done - b.done);

  return (
    <>
      <div className="cal-shell">
        <div className="cal-head">
          <div className="cal-month">
            {first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </div>
          <div className="cal-nav">
            <button onClick={() => step(-1)}>‹</button>
            <button className="today-btn" onClick={goToday}>TODAY</button>
            <button onClick={() => step(1)}>›</button>
          </div>
        </div>
        <div className="cal-dow">{DOW.map((d) => <div key={d}>{d}</div>)}</div>
        <div className="cal-grid">
          {cells.map((d) => {
            const iso = localISO(d);
            const inMonth = d.getMonth() === month;
            const items = byDay[iso] || [];
            const cls = [
              'cal-cell',
              !inMonth && 'dim',
              iso === todayISO() && 'now',
              iso === selected && 'sel',
            ].filter(Boolean).join(' ');
            return (
              <button key={iso} className={cls} onClick={() => setSelected(iso)}>
                <span className="cal-num">{d.getDate()}</span>
                {items.slice(0, 3).map((t) => {
                  const p = projOf(t.project);
                  const fg = t.priority === 'urgent' && !t.done ? 'var(--coral)' : p?.color || 'var(--text-2)';
                  return (
                    <span
                      key={t.id}
                      className={`cal-chip${t.done ? ' spent' : ''}`}
                      style={{ '--chipfg': fg, '--chipbg': fg + '1a' }}
                    >
                      {t.title}
                    </span>
                  );
                })}
                {items.length > 3 && <span className="cal-more">+{items.length - 3} more</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="cal-day-panel">
        <div className="band">
          <span className="band-tag">{fmtLong(selected)}</span>
          <div className="band-rule" />
          <span className="band-n">{dayTasks.length}</span>
        </div>
        {dayTasks.length ? (
          <div className="stack">
            {dayTasks.map((t) => (
              <TaskCard key={t.id} task={t} project={projOf(t.project)} {...cardProps} />
            ))}
          </div>
        ) : (
          <div className="void" style={{ padding: '28px 20px' }}>
            <div className="void-sub">Nothing due this day.</div>
          </div>
        )}
      </div>
    </>
  );
}

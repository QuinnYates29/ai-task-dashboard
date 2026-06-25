export function todayISO() {
  const d = new Date();
  return localISO(d);
}

export function localISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fmtShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtLong(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// negative = overdue, 0 = today, positive = days away
export function daysUntil(iso) {
  if (!iso) return null;
  const a = new Date(todayISO() + 'T00:00:00');
  const b = new Date(iso + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

export function dueLabel(iso) {
  const n = daysUntil(iso);
  if (n === null) return '';
  if (n < -1) return `${-n}d overdue`;
  if (n === -1) return 'yesterday';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 7) return `in ${n}d`;
  return fmtShort(iso);
}

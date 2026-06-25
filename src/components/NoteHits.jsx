import { useEffect, useRef, useState } from 'react';
import * as deck from '../lib/deck';

// Semantic + keyword vault search surfaced under the task list while searching.
export default function NoteHits({ query }) {
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setHits([]);
      return;
    }
    clearTimeout(timer.current);
    const ctrl = new AbortController();
    setBusy(true);
    timer.current = setTimeout(async () => {
      try {
        setHits(await deck.searchNotes(q, ctrl.signal));
      } catch {
        /* aborted or hub down */
      } finally {
        setBusy(false);
      }
    }, 280);
    return () => {
      clearTimeout(timer.current);
      ctrl.abort();
    };
  }, [query]);

  if (query.trim().length < 3 || (!hits.length && !busy)) return null;

  return (
    <div className="note-hits">
      <div className="band">
        <span className="band-tag">⌕ From your vault</span>
        <div className="band-rule" />
        <span className="band-n">{busy ? '…' : hits.length}</span>
      </div>
      <div className="stack">
        {hits.map((h, i) => (
          <button key={i} className="note-hit" onClick={() => deck.openNote(h.path).catch(() => {})} title={`Open ${h.path} in Obsidian`}>
            <div className="note-hit-head">
              <span className="note-hit-path">{h.path.replace(/\.md$/, '')}</span>
              {h.heading && h.heading !== '(top)' && <span className="note-hit-heading">› {h.heading}</span>}
            </div>
            <div className="note-hit-snippet">{h.snippet}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

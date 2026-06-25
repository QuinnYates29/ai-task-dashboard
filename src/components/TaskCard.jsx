import { daysUntil, dueLabel } from '../lib/dates';

export default function TaskCard({ task, project, onToggle, onEdit, onDelete, onJumpProject }) {
  const n = daysUntil(task.deadline);
  const dueClass = n === null ? '' : n < 0 ? 'late' : n === 0 ? 'today' : '';
  const edge = !task.done && task.priority === 'urgent' ? 'var(--coral)' : project?.color || 'transparent';
  const readonly = task.ob?.readonly;

  return (
    <div className={`card${task.done ? ' spent' : ''}`} style={{ '--edge': edge }}>
      <button
        className={`tick${task.done ? ' done' : ''}${readonly ? ' readonly' : ''}`}
        onClick={() => onToggle(task)}
        title={readonly ? 'Logged in Obsidian — edit there' : task.done ? 'Reopen' : 'Complete'}
        aria-label={task.done ? 'Reopen task' : 'Complete task'}
      >
        ✓
      </button>

      <div className="card-mid">
        <div className="card-title">{task.title}</div>
        {task.notes && <div className="card-notes">{task.notes}</div>}
        <div className="tags">
          <span className={`tag pri-${task.priority}`}>{task.priority}</span>
          {project && (
            <span
              className="tag proj"
              style={{ background: project.color + '22', color: project.color }}
              onClick={() => onJumpProject(project.id)}
            >
              ◆ {project.name}
            </span>
          )}
          {task.deadline && (
            <span className={`tag due ${dueClass}`}>⏱ {dueLabel(task.deadline)}</span>
          )}
          {task.source === 'obsidian' && <span className="tag src">◈ obsidian</span>}
        </div>
      </div>

      <div className="card-ops">
        {task.source !== 'obsidian' && (
          <>
            <button className="op" onClick={() => onEdit(task)} title="Edit">✎</button>
            <button className="op danger" onClick={() => onDelete(task)} title="Delete">✕</button>
          </>
        )}
      </div>
    </div>
  );
}

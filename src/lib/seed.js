// Seed data mirrors Quinn's Obsidian vault structure (HOME.md / DASHBOARD.md):
// projects BIST (#fathom), M7 Resetter (#m7), Ollama Multi-Agent (#ollama),
// plus a Personal catch-all. Task tag syntax: inline #work #fathom style.
import { todayISO, localISO } from './dates';

export const PALETTE = [
  '#00e5ff', '#a78bfa', '#4d9fff', '#f472b6',
  '#2dd4bf', '#34d399', '#ff5470', '#fbbf24',
];

export function seedProjects() {
  return [
    { id: 'fathom', name: 'BIST / FATHOM', tag: '#fathom', color: '#2dd4bf' },
    { id: 'm7', name: 'M7 Resetter', tag: '#m7', color: '#a78bfa' },
    { id: 'ollama', name: 'Ollama Multi-Agent', tag: '#ollama', color: '#4d9fff' },
    { id: 'obd2', name: 'OBD2 CAN Reader', tag: '#obd2', color: '#f472b6' },
    { id: 'personal', name: 'Personal', tag: '#personal', color: '#00e5ff' },
  ];
}

function offset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localISO(d);
}

export function seedTasks() {
  const t = todayISO();
  return [
    {
      id: 't1',
      title: 'Run BIST sweep on dock unit and log ECC status',
      notes: 'Capture MCM register dump, append results to Popoto Testing log.',
      project: 'fathom',
      priority: 'urgent',
      deadline: t,
      done: false,
      doneDate: '',
      created: t,
      source: 'local',
    },
    {
      id: 't2',
      title: 'Review FATHOM standup notes and update Current State',
      notes: 'Project overview ## Current State section — mark blockers.',
      project: 'fathom',
      priority: 'medium',
      deadline: offset(1),
      done: false,
      doneDate: '',
      created: t,
      source: 'local',
    },
    {
      id: 't3',
      title: 'Bring up M7 board resetter firmware on bench',
      notes: 'Verify reset pulse timing with scope before flashing rev B.',
      project: 'm7',
      priority: 'urgent',
      deadline: offset(2),
      done: false,
      doneDate: '',
      created: t,
      source: 'local',
    },
    {
      id: 't4',
      title: 'Write backlog triage for M7 project overview',
      notes: 'Move stale daily-note tasks into ### Backlog per vault convention.',
      project: 'm7',
      priority: 'low',
      deadline: '',
      done: false,
      doneDate: '',
      created: t,
      source: 'local',
    },
    {
      id: 't5',
      title: 'Wire Ollama agent to auto-link new vault notes',
      notes: 'Use Template Index as reference; Backlinks + Related sections on create.',
      project: 'ollama',
      priority: 'medium',
      deadline: offset(5),
      done: false,
      doneDate: '',
      created: t,
      source: 'local',
    },
    {
      id: 't6',
      title: 'Benchmark local models for note-classification agent',
      notes: '',
      project: 'ollama',
      priority: 'low',
      deadline: offset(9),
      done: false,
      doneDate: '',
      created: t,
      source: 'local',
    },
    {
      id: 't7',
      title: 'Connect this dashboard to Obsidian Local REST API',
      notes: 'Settings → Obsidian Link. Base https://localhost:27124, bearer key from plugin settings. Accept self-signed cert once in browser.',
      project: 'personal',
      priority: 'medium',
      deadline: offset(3),
      done: false,
      doneDate: '',
      created: t,
      source: 'local',
    },
    {
      id: 't8',
      title: 'Scaffold mission deck dashboard',
      notes: 'React app for desktop + future dedicated screen.',
      project: 'personal',
      priority: 'medium',
      deadline: t,
      done: true,
      doneDate: t,
      created: t,
      source: 'local',
    },
  ];
}

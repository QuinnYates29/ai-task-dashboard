// Project store — persists the project list to .data/projects.json so adding /
// removing a project from the dashboard survives a server restart.
//
// Each project has:
//   id    — stable identifier, derived from the tag (e.g. "fathom") or a
//            timestamp slug for tag-less projects.
//   name  — display name ("BIST / FATHOM")
//   tag   — vault hashtag without the # ("fathom"); empty string means no tag.
//   color — hex color string for the UI.
//
// The file is seeded on first run from the hardcoded defaults so existing vaults
// keep working without any manual migration.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.data');
const STORE = path.join(DATA_DIR, 'projects.json');

export type Project = { id: string; name: string; tag: string; color: string };

const SEED: Project[] = [
  { id: 'fathom',   name: 'BIST / FATHOM',       tag: 'fathom',   color: '#2dd4bf' },
  { id: 'm7',       name: 'M7 Resetter',          tag: 'm7',       color: '#a78bfa' },
  { id: 'ollama',   name: 'Ollama Multi-Agent',   tag: 'ollama',   color: '#4d9fff' },
  { id: 'obd2',     name: 'OBD2 CAN Reader',      tag: 'obd2',     color: '#f472b6' },
  { id: 'personal', name: 'Personal',             tag: 'personal', color: '#00e5ff' },
];

function load(): Project[] {
  try {
    if (fs.existsSync(STORE)) return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {}
  return SEED;
}

function save(projects: Project[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(projects, null, 2));
}

// Seed on first run (no file yet).
if (!fs.existsSync(STORE)) save(SEED);

export function getProjects(): Project[] {
  return load();
}

export function addProject(p: { name: string; tag?: string; color?: string; id?: string }): Project {
  const projects = load();
  const id = p.id || (p.tag ? p.tag.replace(/^#/, '').toLowerCase() : 'p' + Date.now());
  if (projects.some((x) => x.id === id)) throw new Error(`project "${id}" already exists`);
  const proj: Project = {
    id,
    name: p.name,
    tag: (p.tag || '').replace(/^#/, '').toLowerCase().trim(),
    color: p.color || '#00e5ff',
  };
  projects.push(proj);
  save(projects);
  return proj;
}

export function removeProject(id: string): void {
  const projects = load();
  if (!projects.some((p) => p.id === id)) throw new Error(`project "${id}" not found`);
  save(projects.filter((p) => p.id !== id));
}

// Edit a project in place. The id stays stable even if the tag changes, so
// existing task associations by id are preserved. Only provided fields change.
export function updateProject(id: string, patch: Partial<Omit<Project, 'id'>>): Project {
  const projects = load();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`project "${id}" not found`);
  const cur = projects[idx];
  const next: Project = {
    id: cur.id,
    name: patch.name !== undefined ? patch.name : cur.name,
    tag: patch.tag !== undefined ? (patch.tag || '').replace(/^#/, '').toLowerCase().trim() : cur.tag,
    color: patch.color !== undefined ? patch.color : cur.color,
  };
  projects[idx] = next;
  save(projects);
  return next;
}

// ── helpers used by tasks.ts ────────────────────────────────────────────────

// tag → project id  (e.g. "fathom" → "fathom")
export function getTagProject(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of load()) if (p.tag) out[p.tag] = p.id;
  return out;
}

// project id → "#tag"  (e.g. "fathom" → "#fathom") — used when writing task lines
export function getProjectTag(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of load()) if (p.tag) out[p.id] = '#' + p.tag;
  return out;
}

// All tags that buildLine manages (strips from free-tags before re-emitting
// canonical ones) — priority keywords stay hardcoded, projects are dynamic.
export function getManagedTags(): Set<string> {
  const s = new Set<string>(['urgent', 'low']);
  for (const p of load()) if (p.tag) s.add(p.tag);
  return s;
}

// Ordered project id list used by extractMeta to resolve which project tag wins
// when a task carries multiple project tags. Keep specifics before generics.
export function getProjectOrder(): string[] {
  const projects = load();
  // Put 'personal' last — it's the catch-all.
  const rest = projects.filter((p) => p.id !== 'personal').map((p) => p.id);
  const hasPersonal = projects.some((p) => p.id === 'personal');
  return hasPersonal ? [...rest, 'personal'] : rest;
}

// Append-only writes into existing vault notes (the "ingest" primitive).
// Follows Quinn's vault rule: grow existing notes, never create new ones here.
import { readDaily, writeDaily, vaultGet, vaultPut } from './obsidian.js';

// Insert `block` at the end of the section under `heading`. If the heading is
// missing, append the heading + block to the end of the note.
function appendUnderHeading(content: string, heading: string, block: string): string {
  const lines = content.split('\n');
  const re = new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const idx = lines.findIndex((l) => re.test(l));

  if (idx >= 0) {
    let end = idx + 1;
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
    // trim trailing blank lines inside the section, then insert
    while (end > idx + 1 && lines[end - 1].trim() === '') end--;
    lines.splice(end, 0, block);
    return lines.join('\n');
  }
  const sep = content.trim() === '' ? '' : '\n';
  return `${content}${sep}\n### ${heading}\n${block}\n`;
}

export async function appendToDaily(heading: string, block: string): Promise<void> {
  const content = (await readDaily()) ?? '';
  await writeDaily(appendUnderHeading(content, heading, block));
}

export async function appendToNote(path: string, heading: string, block: string): Promise<string> {
  const content = await vaultGet(path); // throws on Independent/ paths
  if (content == null) throw new Error(`${path} not found`);
  await vaultPut(path, appendUnderHeading(content, heading, block));
  return path;
}

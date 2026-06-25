// Classification eval — measures how well task parsing assigns projects.
// Run: npm run eval   (needs Ollama + Obsidian reachable, since it uses RAG grounding)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTasks } from '../src/chat.js';
import type { Provider } from '../src/router.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(here, 'classification.json'), 'utf8'));
const provider: Provider = (process.argv[2] as Provider) || 'local';

async function main() {
  console.log(`\nClassification eval — provider: ${provider}\n`);
  let correct = 0;
  for (const c of data.cases) {
    let got = 'error';
    try {
      const { tasks } = await extractTasks(c.input, data.projects, provider);
      got = tasks[0]?.project || 'none';
    } catch (e: any) {
      got = `error(${e.message})`;
    }
    const ok = got === c.expected;
    if (ok) correct++;
    console.log(`${ok ? '✓' : '✗'}  ${String(got).padEnd(10)} (want ${String(c.expected).padEnd(8)})  ${c.input}`);
  }
  const pct = Math.round((correct / data.cases.length) * 100);
  console.log(`\n${correct}/${data.cases.length} correct (${pct}%)\n`);
}

main();

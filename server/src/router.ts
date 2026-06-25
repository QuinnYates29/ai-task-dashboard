// Model router — LOCAL FIRST, Claude as opt-in escalation.
//
//   provider 'auto'  (default): use Ollama if reachable, else fall back to Claude.
//   provider 'local'         : Ollama only (nothing leaves the machine).
//   provider 'claude'        : Claude only.
//
// Both backends support structured output via a JSON schema, so callers get the
// same guaranteed-shape JSON regardless of which model answered.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

export const anthropic = config.anthropic.enabled ? new Anthropic() : null;

export type Provider = 'auto' | 'local' | 'claude';
export interface CompleteOpts {
  system?: string;
  user: string;
  schema?: unknown; // JSON schema → structured output
}

export async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${config.ollama.url}/api/tags`);
    return r.ok;
  } catch {
    return false;
  }
}

async function localComplete({ system, user, schema }: CompleteOpts): Promise<string> {
  const body: any = {
    model: config.ollama.chatModel,
    stream: false,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
  };
  if (schema) body.format = schema; // Ollama structured outputs
  const r = await fetch(`${config.ollama.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ollama chat: ${r.status} ${r.statusText}`);
  const j: any = await r.json();
  return j.message?.content ?? '';
}

// Streaming local completion — emits text deltas via onDelta, returns full text.
export async function localCompleteStream(
  { system, user }: CompleteOpts,
  onDelta: (text: string) => void,
): Promise<string> {
  const r = await fetch(`${config.ollama.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.chatModel,
      stream: true,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok || !r.body) throw new Error(`ollama chat: ${r.status} ${r.statusText}`);

  const reader = (r.body as any).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        const j = JSON.parse(s);
        const piece = j.message?.content ?? '';
        if (piece) {
          full += piece;
          onDelta(piece);
        }
      } catch {
        /* partial line — ignore */
      }
    }
  }
  return full;
}

async function claudeComplete({ system, user, schema }: CompleteOpts): Promise<string> {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not set — Claude escalation unavailable');
  const req: any = {
    model: config.anthropic.model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: user }],
  };
  if (system) req.system = system;
  if (schema) req.output_config = { format: { type: 'json_schema', schema } };
  const res: any = await anthropic.messages.create(req);
  const block = res.content.find((b: any) => b.type === 'text');
  return block?.text ?? '';
}

export async function complete(
  opts: CompleteOpts,
  provider: Provider = 'auto',
): Promise<{ text: string; provider: 'local' | 'claude' }> {
  if (provider === 'claude') return { text: await claudeComplete(opts), provider: 'claude' };
  if (provider === 'local') return { text: await localComplete(opts), provider: 'local' };

  // auto: prefer local, fall back to Claude on unavailability/failure
  if (await ollamaUp()) {
    try {
      return { text: await localComplete(opts), provider: 'local' };
    } catch {
      /* fall through to Claude */
    }
  }
  return { text: await claudeComplete(opts), provider: 'claude' };
}

// Embed one or many texts. `kind` adds nomic's task prefixes — nomic-embed-text
// is trained to receive "search_query:"/"search_document:", and using them
// measurably improves retrieval. Batched via /api/embed, with a per-item
// fallback to the older /api/embeddings endpoint.
export async function embedBatch(
  texts: string[],
  kind: 'query' | 'document' = 'document',
): Promise<number[][]> {
  const usePrefix = /nomic/i.test(config.ollama.embedModel);
  const prefix = usePrefix ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
  const input = texts.map((t) => prefix + t);

  const r = await fetch(`${config.ollama.url}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.ollama.embedModel, input }),
  });
  if (r.ok) {
    const j: any = await r.json();
    if (Array.isArray(j.embeddings)) return j.embeddings;
  }

  // fallback: older single-item endpoint
  const out: number[][] = [];
  for (const t of input) {
    const rr = await fetch(`${config.ollama.url}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.ollama.embedModel, prompt: t }),
    });
    if (!rr.ok) throw new Error(`ollama embeddings: ${rr.status} ${rr.statusText}`);
    const jj: any = await rr.json();
    out.push(jj.embedding ?? []);
  }
  return out;
}

export async function embed(text: string, kind: 'query' | 'document' = 'document'): Promise<number[]> {
  return (await embedBatch([text], kind))[0] ?? [];
}

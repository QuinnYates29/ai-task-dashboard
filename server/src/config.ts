import 'dotenv/config';

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined ? dflt : v === 'true' || v === '1';

export const config = {
  port: Number(process.env.PORT ?? 8787),

  obsidian: {
    enabled: !!process.env.OBSIDIAN_API_KEY,
    apiKey: process.env.OBSIDIAN_API_KEY ?? '',
    useHttp: bool(process.env.OBSIDIAN_USE_HTTP, true),
    httpUrl: process.env.OBSIDIAN_HTTP_URL ?? 'http://127.0.0.1:27123',
    httpsUrl: process.env.OBSIDIAN_HTTPS_URL ?? 'https://127.0.0.1:27124',
    dailyFolder: process.env.OBSIDIAN_DAILY_FOLDER ?? 'Daily Notes',
    files: (process.env.OBSIDIAN_FILES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  ollama: {
    url: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'llama3.1',
    embedModel: process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
    // Native tool-calling for the local chat path (needs a capable model like
    // qwen2.5 / llama3.1 — mistral's tool use is unreliable). Off by default.
    tools: bool(process.env.OLLAMA_TOOLS, false),
  },

  rag: {
    hybrid: bool(process.env.RAG_HYBRID, true), // fuse vector + keyword search
    hyde: bool(process.env.RAG_HYDE, false), // hypothetical-doc expansion (adds a local LLM call/query)
    reindexMinutes: Number(process.env.RAG_REINDEX_MINUTES ?? 15), // 0 = off
  },

  anthropic: {
    enabled: !!process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  },
};

export function obsidianBase() {
  return config.obsidian.useHttp ? config.obsidian.httpUrl : config.obsidian.httpsUrl;
}

#!/usr/bin/env bash
# Control the local A.L.F.R.E.D. stack (Ollama + Deck Server).
#   ./deck.sh up      → start Ollama (if down) + the Deck Server (foreground)
#   ./deck.sh down    → stop Deck Server + unload Ollama models (free RAM)
#   ./deck.sh down --quit-ollama → also quit the Ollama daemon
#   ./deck.sh status  → what's running
cd "$(dirname "$0")"

ollama_up() { curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; }

case "${1:-up}" in
  up)
    if ! ollama_up; then
      echo "→ starting Ollama…"
      open -a Ollama 2>/dev/null || (ollama serve >/tmp/ollama.log 2>&1 &)
      for _ in $(seq 1 30); do ollama_up && break; sleep 0.5; done
    fi
    ollama_up && echo "✓ Ollama up" || { echo "✗ Ollama didn't start"; exit 1; }
    echo "→ starting Deck Server (Ctrl-C to stop)…"
    exec npm run dev
    ;;
  down)
    echo "→ stopping Deck Server…"
    pkill -f "tsx.*src/index.ts" 2>/dev/null && echo "  stopped" || echo "  (not running)"
    echo "→ unloading Ollama models…"
    if ollama_up; then
      ollama ps | awk 'NR>1 {print $1}' | while read -r m; do
        [ -n "$m" ] && ollama stop "$m" && echo "  unloaded $m"
      done
    fi
    if [ "${2:-}" = "--quit-ollama" ]; then
      echo "→ quitting Ollama…"
      osascript -e 'quit app "Ollama"' 2>/dev/null || pkill -f "ollama serve" 2>/dev/null || true
    fi
    echo "✓ done"
    ;;
  status)
    ollama_up && echo "ollama serve: up" || echo "ollama serve: down"
    ollama_up && ollama ps
    pgrep -f "tsx.*src/index.ts" >/dev/null && echo "deck server: up" || echo "deck server: down"
    ;;
  *)
    echo "usage: ./deck.sh {up | down [--quit-ollama] | status}"
    exit 1
    ;;
esac

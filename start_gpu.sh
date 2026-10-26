#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TRELLIS2_ROOT="${TRELLIS2_ROOT:-$PROJECT_ROOT/TRELLIS.2}"
export DATA_DIR="${DATA_DIR:-$PROJECT_ROOT/data}"
export PORT="${PORT:-7860}"

# Optional local .env reader (simple KEY=value format; no shell expansion).
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "${key// /}" || "$key" == \#* ]] && continue
    value="${value%$'\r'}"
    export "$key=$value"
  done < "$PROJECT_ROOT/.env"
fi

if [[ -z "${APP_ACCESS_KEY:-}" ]]; then
  echo "WARNING: APP_ACCESS_KEY is empty. Do not expose this server publicly without access control." >&2
fi

cd "$PROJECT_ROOT"
exec conda run --no-capture-output -n trellis2 python -m uvicorn backend.server:app --host 0.0.0.0 --port "$PORT"

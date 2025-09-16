#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing root dependencies"
cd "$ROOT_DIR"
npm install

echo "==> Installing backend dependencies"
cd "$ROOT_DIR/backend"
npm install

echo "==> Installing frontend dependencies"
cd "$ROOT_DIR/frontend"
npm install

echo "==> Playwright browsers install (backend)"
npx playwright install --with-deps || true

cat <<EOF

Setup complete.

Next steps:
1) Export your OpenAI key (for AI agent):
   export OPENAI_API_KEY="sk-..."; export OPENAI_MODEL="gpt-4o-mini"

2) Start dev servers in two terminals or via root script:
   Terminal A:
     cd "$ROOT_DIR/backend" && npm run dev
   Terminal B:
     cd "$ROOT_DIR/frontend" && npm run dev

Or from root (requires concurrently installed):
   npm run dev

3) Open the app:
   Frontend: http://localhost:3000
   Backend API: http://localhost:3001/api

4) Test AI flows:
   - Navigate to "Run via AI" (sidebar) and start a run with a goal and start URL.
   - Or go to "Create Test" and use the AI flow section to run with a generic prompt.

Artifacts:
   Videos/screens: backend/test-results/

EOF



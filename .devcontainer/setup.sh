#!/usr/bin/env bash
# Runs once when the Codespace (or local dev container) is created.
set -euo pipefail

# .env for the database; the OpenRouter key comes from the Codespaces secret
# (environment variables already set are not overridden by .env).
if [ ! -f .env ]; then
  sed 's#^DATABASE_URL=.*#DATABASE_URL="postgresql://app:app@db:5432/ask_harness"#' .env.example > .env
fi

npm install

# Wait for Postgres to accept connections.
for i in $(seq 1 30); do
  node -e "const {Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL||'postgresql://app:app@db:5432/ask_harness'});c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1))" && break
  echo "Waiting for Postgres... ($i)"; sleep 2
done

npm run db:migrate
npm run db:seed

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo
  echo "No OPENROUTER_API_KEY secret found. The app will open, but chatting needs a key:"
  echo "add it as a Codespaces secret (github.com/settings/codespaces) or in .env, then restart 'npm run dev'."
fi

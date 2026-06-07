# NoPM

**A lite, API-first project-management tool your AI agent operates** — like the `aws` / `supabase` / `hubspot` CLIs, but for project governance. NoPM bundles no LLM; *your* agent (Claude Code, Cursor, Copilot) drives it over a documented REST API + scoped token.

The differentiator is **institutional governance built into the data layer**: an immutable audit log, scoped Bearer tokens, and maker-checker (four-eyes) approval on destructive actions — enforced by the database, not bolted onto the UI.

> Portfolio proof-piece. Live at **stillnotbald.com**.

## Layout
```
NoPM/
├─ web/            Next.js 16 app (the product) — API, console, CLI, migrations
├─ requirements/   REQUIREMENTS.md (canonical) + TRACEABILITY.md (RTM)
├─ sprint-log/     dated build receipts (the "5× parallel-track" method)
├─ docs/adr/       architectural decision records
└─ scripts/        rtm-verify drift checker
```

## Develop
```bash
npm install --prefix web      # deps
npm run dev                   # web app on :3000
npm run migrate               # apply SQL migrations (set DB_URL first)
npm run rtm:verify            # check requirements ↔ RTM in sync
```
Secrets live in `web/.env.local` (gitignored). See `web/.env.example`.

## Stack
Next.js 16 · TypeScript · Tailwind v4 · Supabase (Postgres + Auth + RLS) · Vercel + Cloudflare DNS.

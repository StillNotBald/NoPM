# NoPM — the constitution

## What this is
A **lite, API-first project-management tool that a user's own AI agent operates** (like the `aws` / `supabase` / `hubspot` CLIs — NoPM bundles **no** LLM). It is Chu Ling's **live-hosted portfolio proof-piece** for employers, deployed to **stillnotbald.com**. The thesis is the resume line: *"I build the systems that make unclear requirements impossible."* Governance (audit, traceability, change-control) is engineered into the **data + API layer**, not the UI.

## Stack — do not deviate (ask first)
Next.js **16** (App Router) · TypeScript · **Tailwind v4** · shadcn-style primitives on **prior-console-app "Claude Design Language" tokens** (cream `#FAF9F5` + coral `#D97757`) · **Supabase** (Postgres + Auth + RLS) · **Vercel** host + **Cloudflare** DNS.
Approved libs: `@supabase/ssr`, `@supabase/supabase-js`, `zod`, `otplib`, `pptxgenjs`, `jspdf`, `html2canvas`, `dnd-kit`, `resend` (demo-mode), `pg` (migration runner). Nothing else without asking.

## Scope (v1) — 8 modules + governance
Workspace → Project → Milestone → Task (typed statuses) · **Risk** · **Issue** · **Clash** (schedule/resource/dependency, cross-project) · **Resource** (people, cost-rate, capacity, allocation, timesheets) · **Budget** (planned/committed/actual/variance/burn). Governance-wired **Kanban** (drag = audited) + read-mostly **Gantt** (lock → rebaseline). **Trust Center** (audit stream + provenance). Deck export PPTX/PDF/HTML. Landing + case study + seed.

## Conventions — always
- **Governance is invisible** in operational flows, but *showcased* in the Trust Center. Enforce audit/scopes/maker-checker in the data + API layer, never as UI clutter.
- **Every mutation = exactly one immutable `audit_log` row** (`writeAudit`, fail-closed). No silent writes.
- **API = data-access layer**: every action is a documented `app/api/**/route.ts`; the web UI and CLI only call the API. Wrap handlers with `route()` from `@/lib/api/handler`.
- **One JSON contract**: success `{ data }` (+ `total/page/limit`); failure `{ error }` (+ `fields`). Correct codes (401 auth, 403 scope, 404, 422 rule). Use `@/lib/api/response` + `@/lib/api/errors`.
- **Scoped Bearer PATs** (`npm_`, SHA-256 hashed, shown once; scopes `resource:action`). Token callers use the admin client → **always filter queries by `actor.workspaceId`** (RLS is bypassed for them).
- **Maker-checker on delete-task**: `deletion_requests` (request → approve); approver ≠ requester (DB CHECK + API guard); self-approval rejected (422/403).
- Secrets hashed at rest, shown once, never logged.

## Commands
- Dev: `npm run dev`  ·  Build: `npm run build`  ·  Lint: `npm run lint`
- Migrate: `npm run migrate` (set `DB_URL` to the Supabase connection string first)
- Test: `npm run test` (vitest — added in W6)
- Supabase project: `nopm` / ref `supabase-project-ref` / ap-southeast-1. Secrets in `web/.env.local` (gitignored).

## Discipline (lite predecessor-platform)
- `requirements/REQUIREMENTS.md` (R-IDs, canonical) + `requirements/TRACEABILITY.md` (RTM mirror — update the same row in the same commit; `npm run rtm:verify`).
- `sprint-log/<date>_<intent>/` from `_template/` — `SPRINT_SUMMARY.md` always (the receipt), `PLAN.md`/`DECISIONS.md` when warranted.
- `docs/adr/NNNN-*.md` for architectural/irreversible decisions.

## Do NOT build (ask first)
Native MCP server (strong Phase-1.5), real email send (Resend is demo-mode), dry-run gates, OAuth/PKCE, multi-tenant beyond workspace_id+RLS, custom-field engine, automations, extra view types, comments/notifications-threads, any bundled LLM.

## Hard rule
Before adding anything not in v1 scope: **STOP and ask.**

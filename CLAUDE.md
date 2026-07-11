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

## Agent profile

- test: `cd web && npm run test` (vitest)
- typecheck: `cd web && npx tsc --noEmit`
- gate: `npm run rtm:verify` (RTM consistency; run from `web/` — a copy also exists at `scripts/rtm-verify.mjs`)
- rtm: `requirements/REQUIREMENTS.md` + `requirements/TRACEABILITY.md` (same-commit rule)
- sprintLog: `sprint-log/<date>_<intent>/` from `_template/` (SPRINT_SUMMARY.md always)
- uiTemplates: prior-console-app "Claude Design Language" tokens (cream `#FAF9F5` + coral `#D97757`), shadcn-style primitives
- sanitization: no real client/stakeholder names in tracked .md; portfolio-public repo
- memoryStore: `~/.claude/projects/<redacted>/memory/`

## Do NOT build (ask first)
real email **send** (Resend stays demo-mode — previews only), dry-run gates, OAuth/PKCE, multi-tenant beyond workspace_id+RLS, custom-field engine, automations, comments/notification-threads, any bundled LLM. (Extra view types are also ask-first — the **Mainline** timeline UI is greenlit but parked.)

## Sanctioned (already greenlit, in scope)
- **BYOK governed assistant** (R-24, ADR 0004) — an in-app assistant where the user pastes their **own** OpenAI/Anthropic/Google **API key** (AES-256-GCM at rest) and that model drives NoPM's REST API via an **ephemeral scoped token** (audited as a token actor; deletes → maker-checker). NoPM still ships **no model and no key** — the "no bundled LLM" rule holds. Optional owner-funded demo key (`NOPM_DEMO_LLM_*`) is rate-limited and server-only.
- **Notification center** (R-37) — in-app bell + My Work hub fed from governed events. Now **realtime** (Supabase Realtime live bell, R-27) + **email demo-previews** (R-27) — rendered, never sent (Resend stays demo-mode).
- **Native MCP server** (R-25, ADR 0007) — NoPM exposed as MCP tools (stdio) so any MCP client drives the REST API via a scoped PAT; governance enforced server-side. NoPM still bundles no LLM — this is a thin agent surface, like the aws/supabase MCP servers. (`web/mcp/`.)
- **Assistant streaming + persistence** (R-26) — additive SSE streaming (JSON path preserved) + saved conversations; assistant tools cross-checked vs OpenAPI + least-privilege (never gains an approve/admin scope).
- **Mainline timeline feed** (R-28) — governed `GET /api/timeline` portfolio graph + real task-dependency DAG. The 3-lens switcher **UI is parked** (design-approved); the feed/data are live.

## Hard rule
Before adding anything not in v1 scope: **STOP and ask.**

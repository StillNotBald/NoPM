# NoPM — Requirements (canonical)

Status legend: **DONE** · **PARTIAL** · **TODO** · **DEFERRED**. The RTM (`TRACEABILITY.md`) mirrors this file — update the matching row in the same commit.

## Governance backbone
- **R-01** Immutable audit log — every mutation writes exactly one append-only row (actor, action, target, before/after). — **DONE** (schema + `writeAudit` + DB trigger; all 42 route.ts wrapped)
- **R-02** Scoped Bearer PAT auth — `npm_` prefix, SHA-256 hash (raw shown once), `resource:action` scopes, expiry/revoke. — **DONE** (lib + mint/list/revoke endpoints + TOTP enrollment)
- **R-03** Maker-checker on delete-task — `deletion_requests` request→approve; approver ≠ requester; self-approval rejected. — **DONE** (schema + DB CHECK + request/approve/reject endpoints; four-eyes loop verified)
- **R-04** Control-Tower — project timeline lock → rebaseline sign-off (multi-approver → atomic apply). — **DONE** (schema + lock/unlock/rebaseline/signoff/apply endpoints)
- **R-05** Dual auth — Supabase session + **TOTP MFA** (enroll/verify/recover + backup codes). — **DONE** (otplib v12; enroll/verify/disable routes)
- **R-06** Workspace RLS isolation on every table. — **DONE** (21 tables; workspace_id RLS on every table)

## PM domain (8 modules)
- **R-10** Projects CRUD (code, owner, RAG, completion, dates, currency, lock). — **DONE**
- **R-11** Milestones CRUD. — **DONE**
- **R-12** Tasks CRUD + typed statuses (backlog/started/done/canceled). — **DONE**
- **R-13** Risk register. — **DONE**
- **R-14** Issue register. — **DONE**
- **R-15** Clash register (schedule/resource/dependency, cross-project). — **DONE**
- **R-16** Resource members + allocation; over-allocation auto-surfaces a resource clash. — **DONE**
- **R-17** Timesheets (hours × rate snapshot). — **DONE**
- **R-18** Budget — planned/committed/actual (labor+expenses)/variance/burn. — **DONE**

## Agent-operable surface
- **R-20** API = data layer; `{data}`/`{error}` contract; correct status codes. — **DONE** (42 route.ts; `route()` wrapper; response/error helpers)
- **R-21** OpenAPI spec at `GET /api/openapi.json`. — **DONE**
- **R-22** `/llms.txt` endpoint index for agent discovery. — **DONE**
- **R-23** `nopm` CLI (auth/projects/tasks/audit/report). — **DONE** (cli/nopm.mjs)

## Console (prior-console-app look)
- **R-30** RAG portfolio dashboard (health cards, project table, filter pills). — **DONE**
- **R-31** Registers as tables + right-inspector. — **DONE**
- **R-32** Kanban — drag = an audited status change. — **DONE**
- **R-33** Gantt — read-mostly; locked timeline → rebaseline flow. — **DONE**
- **R-34** Approvals queue. — **DONE**
- **R-35** Trust Center — live audit stream + per-entity provenance. — **DONE**
- **R-36** Token/scope management UI. — **DONE**
- **R-37** Notification center + demo-mode email previews. — **DEFERRED** (resend absent; notifications table exists; no UI; explicit DEFER pending review)

## Reporting & front door
- **R-40** Deck export PPTX/PDF/HTML (data-driven, server-side). — **DONE**
- **R-50** Public landing + case study (wedges, hero, try-demo). — **DONE**
- **R-51** One-page case-study PDF. — **TODO**
- **R-52** Seed script — demo workspace, users, projects, an over-allocation clash, budget variance, audit history, one pending approval. — **DONE**

## Quality & release
- **R-60** vitest unit + governance-invariant tests (1 audit row/mutation; self-approval rejected; scope-less token 403; audit immutability). — **TODO** (vitest in devDeps; test script wired; no test files yet)
- **R-61** Playwright E2E = AI-orchestrated UAT (agent drives suite vs checklist). — **TODO** (stretch goal)
- **R-62** Deploy to Vercel + Cloudflare DNS (stillnotbald.com); seed live. — **TODO**

# NoPM — Requirements (canonical)

Status legend: **DONE** · **PARTIAL** · **TODO** · **DEFERRED**. The RTM (`TRACEABILITY.md`) mirrors this file — update the matching row in the same commit.

## Governance backbone
- **R-01** Immutable audit log — every mutation writes exactly one append-only row (actor, action, target, before/after). — **DONE** (schema + `writeAudit`)
- **R-02** Scoped Bearer PAT auth — `npm_` prefix, SHA-256 hash (raw shown once), `resource:action` scopes, expiry/revoke. — **PARTIAL** (lib done; mint/list/revoke endpoints TODO)
- **R-03** Maker-checker on delete-task — `deletion_requests` request→approve; approver ≠ requester; self-approval rejected. — **PARTIAL** (schema done; endpoints TODO)
- **R-04** Control-Tower — project timeline lock → rebaseline sign-off (multi-approver → atomic apply). — **PARTIAL** (schema done)
- **R-05** Dual auth — Supabase session + **TOTP MFA** (enroll/verify/recover + backup codes). — **TODO**
- **R-06** Workspace RLS isolation on every table. — **DONE**

## PM domain (8 modules)
- **R-10** Projects CRUD (code, owner, RAG, completion, dates, currency, lock). — **TODO**
- **R-11** Milestones CRUD. — **TODO**
- **R-12** Tasks CRUD + typed statuses (backlog/started/done/canceled). — **TODO**
- **R-13** Risk register. — **TODO**
- **R-14** Issue register. — **TODO**
- **R-15** Clash register (schedule/resource/dependency, cross-project). — **TODO**
- **R-16** Resource members + allocation; over-allocation auto-surfaces a resource clash. — **TODO**
- **R-17** Timesheets (hours × rate snapshot). — **TODO**
- **R-18** Budget — planned/committed/actual (labor+expenses)/variance/burn. — **TODO**

## Agent-operable surface
- **R-20** API = data layer; `{data}`/`{error}` contract; correct status codes. — **PARTIAL** (libs done)
- **R-21** OpenAPI spec at `GET /api/openapi.json`. — **TODO**
- **R-22** `/llms.txt` endpoint index for agent discovery. — **TODO**
- **R-23** `nopm` CLI (auth/projects/tasks/audit/report). — **TODO**

## Console (prior-console-app look)
- **R-30** RAG portfolio dashboard (health cards, project table, filter pills). — **TODO**
- **R-31** Registers as tables + right-inspector. — **TODO**
- **R-32** Kanban — drag = an audited status change. — **TODO**
- **R-33** Gantt — read-mostly; locked timeline → rebaseline flow. — **TODO**
- **R-34** Approvals queue. — **TODO**
- **R-35** Trust Center — live audit stream + per-entity provenance. — **TODO**
- **R-36** Token/scope management UI. — **TODO**
- **R-37** Notification center + demo-mode email previews. — **TODO**

## Reporting & front door
- **R-40** Deck export PPTX/PDF/HTML (data-driven, server-side). — **TODO**
- **R-50** Public landing + case study (wedges, hero, try-demo). — **TODO**
- **R-51** One-page case-study PDF. — **TODO**
- **R-52** Seed script — demo workspace, users, projects, an over-allocation clash, budget variance, audit history, one pending approval. — **TODO**

## Quality & release
- **R-60** vitest unit + governance-invariant tests (1 audit row/mutation; self-approval rejected; scope-less token 403; audit immutability). — **TODO**
- **R-61** Playwright E2E = AI-orchestrated UAT (agent drives suite vs checklist). — **TODO**
- **R-62** Deploy to Vercel + Cloudflare DNS (stillnotbald.com); seed live. — **TODO**

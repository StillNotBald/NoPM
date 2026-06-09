# NoPM — Requirements (canonical)

Status legend: **DONE** · **PARTIAL** · **TODO** · **DEFERRED**. The RTM (`TRACEABILITY.md`) mirrors this file — update the matching row in the same commit.

## Governance backbone
- **R-01** Immutable audit log — every mutation writes exactly one append-only row (actor, action, target, before/after). — **DONE** (schema + `writeAudit` + DB trigger; all 42 route.ts wrapped)
- **R-02** Scoped Bearer PAT auth — `npm_` prefix, SHA-256 hash (raw shown once), `resource:action` scopes, expiry/revoke. — **DONE** (lib + mint/list/revoke endpoints + TOTP enrollment)
- **R-03** Maker-checker on delete-task — `deletion_requests` request→approve; approver ≠ requester; self-approval rejected. — **DONE** (schema + DB CHECK + request/approve/reject endpoints; four-eyes loop verified)
- **R-04** Control-Tower — project timeline lock → rebaseline sign-off (multi-approver → atomic apply). — **DONE** (schema + lock/unlock/rebaseline/signoff/apply endpoints)
- **R-05** Dual auth — Supabase session + **TOTP MFA** (enroll/verify/recover + backup codes). — **DONE** (otplib v12; enroll/verify/disable routes)
- **R-06** Workspace RLS isolation on every table. — **DONE** (21 tables; workspace_id RLS on every table)
- **R-07** Change-control register — raise → assess (scope/schedule/cost impact) → four-eyes decision (decider ≠ requester, DB CHECK + API guard) → audited; under-review CRs surface in the Review Queue. — **DONE**
- **R-08** Decision log — governed record of programme decisions (context / options / decision / rationale, with a supersedes chain). — **DONE**

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
- **R-24** BYOK governed AI assistant — the user's own LLM (OpenAI/Anthropic/Google) operates NoPM through the REST API under an ephemeral scoped token; API keys AES-256-GCM encrypted at rest (never returned/logged); creates are audited as a token actor and deletes bounce to maker-checker. — **DONE** (crypto + assistant_credentials deny-all RLS + providers/tools/token/loop + chat/credentials routes + panel/setup UI)

## Console (prior-console-app look)
- **R-30** RAG portfolio dashboard (health cards, project table, filter pills). — **DONE**
- **R-31** Registers as tables + right-inspector. — **DONE**
- **R-32** Kanban — drag = an audited status change. — **DONE**
- **R-33** Gantt — read-mostly; locked timeline → rebaseline flow; milestone/task **baselines** captured on lock (slip = current vs baseline shown as ghost bars + variance). — **DONE**
- **R-34** Approvals queue. — **DONE**
- **R-35** Trust Center — live audit stream + per-entity provenance. — **DONE**
- **R-36** Token/scope management UI. — **DONE**
- **R-37** Notification center (in-app bell + My Work hub, fed from governed events). — **DONE** (publish.ts fail-soft notify + resolvers; /api/notifications GET/PATCH/read-all; header bell + unread badge; My Work hub; demo-mode email previews still DEFERRED — resend absent)
- **R-38** Review Queue — one hub aggregating every pending decision (approvals, rebaseline sign-offs, in-review documents, high/critical risks, open clashes); ends the PM "long email trail". — **DONE** (gather.ts fans out 5 governed sources → priority-sorted queue; /review page; deep-links to each action)
- **R-39** Documents register + real file storage — governed document control (folder/version/approval/owner/provenance) with files in a private Supabase Storage bucket via signed upload/download URLs; inline PDF/image preview; all access workspace-checked + audited. — **DONE** (documents table + RLS; /api/documents CRUD; signed upload/attach/download/remove; folder-tree viewer; 19 seeded docs each with a real PDF)
- **R-41** Cross-project **My Tasks** — every task assigned to me across all projects, grouped by project, with overdue/due-soon flags + client filters. — **DONE**
- **R-42** **Portfolio roadmap** — all projects' milestones on one swim-lane timeline (RAG-tinted bars + milestone markers + baseline-slip), reusing the Gantt primitives. — **DONE**
- **R-43** Navigation IA — grouped sidebar (Overview/Delivery/Registers/Capacity/Governance) + project switcher with recents + route-derived breadcrumbs; customizable mobile bottom-nav retained. — **DONE**
- **R-44** Unified person identity — task assignment, capacity/allocation, and cost are one `resource_member` (`tasks.assignee_id → resource_members`); logins bridge via `resource_members.profile_id`, so My Work/My Tasks resolve "my" tasks and the Resources view shows each person's open-task load beside capacity + cost. — **DONE** (migration 0019; My Work/My Tasks bridge; Resources open-tasks column)

- **R-45** Smart entity navigation — every entity reference (project/risk/issue/task/clash/decision/CR/doc name) is a deep-link; register pages auto-open the inspector from a focus query param (`?risk=…`, `?dec=…`, `?cr=…`, `?clash=…`); global search routes straight to the record. — **DONE**
- **R-46** Account & identity menu — top-right avatar menu (profile, settings, keyboard shortcuts, support, sign-out); editable display-name profile (`PATCH /api/me`, audited); settings restructured (Profile / Security / About). — **DONE**
- **R-47** Team membership UI — create a resource member and allocate people to projects from the console (Add member / Allocate), closing the gap where only the API/CLI could add people. — **DONE**
- **R-48** Structured form layout — `FormShell`/`FormSection`/`FormGrid` group flat field stacks into Jira-style sections across the risk/issue/decision/change/project/milestone/task forms. — **DONE**

## Reporting & front door
- **R-40** Deck export PPTX/PDF/HTML (data-driven, server-side). — **DONE**
- **R-50** Public landing + case study (wedges, hero, try-demo). — **DONE**
- **R-51** One-page case-study PDF (employer-facing) + public `/case-study` page. — **DONE** (client jsPDF one-pager: thesis, wedges, build summary, proof metrics, live URL)
- **R-52** Seed script — demo workspace, users, projects, an over-allocation clash, budget variance, audit history, one pending approval. — **DONE**

## Quality & release
- **R-60** vitest unit + governance-invariant tests — token hashing/scopes; requireScope token+user/viewer; four-eyes self-approval; BYOK crypto (round-trip/tamper/wrong-key); assistant token scopes (can request but never approve a delete); document storage path-safety; **scope registry validation; EVM math (both SPI modes + divide-by-zero); admin-client workspace-isolation guard**. — **DONE** (119/119 green; `npm test`)
- **R-61** Playwright E2E = AI-orchestrated UAT (agent drives suite vs checklist). — **TODO** (stretch goal)
- **R-62** Deploy to Vercel + Cloudflare DNS (stillnotbald.com); seed live. — **DONE** (live on stillnotbald.com; migrations + seed applied; `apply-migrations.mjs` + `migrate.mjs`)

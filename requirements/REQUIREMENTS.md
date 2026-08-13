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
- **R-21** OpenAPI spec at `GET /api/openapi.json` — documents **every** route, guarded by a coverage **drift test** that fails CI on any undocumented route. — **DONE**
- **R-22** `/llms.txt` endpoint index for agent discovery. — **DONE**
- **R-23** `nopm` CLI (auth/projects/tasks/audit/report + all 8 modules, timeline, openapi). Contract-tested (stubbed-API URL/body assertions + missing-id guards), installable (`bin`, MIT, engines), errors-as-exceptions (no mid-request `process.exit`), central `--help`/`-h` that never fires an API call, `--curl` dry-run with the token masked, PAT config saved 0600. — **DONE** (cli/nopm.mjs; 15 node:test contract tests)
- **R-24** BYOK governed AI assistant — the user's own LLM (OpenAI/Anthropic/Google/OpenRouter) operates NoPM through the REST API under an ephemeral scoped token; API keys AES-256-GCM encrypted at rest (never returned/logged); creates are audited as a token actor and deletes bounce to maker-checker. If no provider call succeeds (no credentials, demo key exhausted, upstream capacity/network error), a deterministic grounded fallback answers from the same read-only tools over the same ephemeral-token lifecycle, rate-limited, never a write, never a raw upstream error. — **DONE** (crypto + assistant_credentials deny-all RLS + providers/tools/token/loop + fallback + chat/credentials routes + panel/setup UI)

- **R-25** Native MCP server — NoPM exposed as MCP tools (stdio, `@modelcontextprotocol/sdk`) so any MCP client drives the governed REST API via a scoped PAT; scopes + audit + maker-checker enforced server-side. — **DONE** (`web/mcp/server.mjs`; verified end-to-end: tools/list + live `list_projects`)
- **R-26** Assistant streaming + conversation persistence — additive SSE streaming of the final reply (the JSON path is byte-for-byte preserved) + saved conversations/messages (deny-all RLS, API-owned); assistant tools cross-checked against OpenAPI + least-privilege (no approve/admin/token/`*` scopes). The demo provider is env-selected (`NOPM_DEMO_LLM_PROVIDER`, including `openrouter`) and the shared demo login gets a fresh chat every visit — no conversation is ever created, loaded, or persisted for that identity, so no visitor's chat is reachable by the next. — **DONE**
- **R-27** Realtime notification bell + email demo-previews — live bell via Supabase Realtime; rendered email previews (Resend stays demo-mode — never sent). — **DONE**
- **R-64** Agent tool-registry integrity — ONE tool registry (`web/mcp/tools.mjs`) shared verbatim by the MCP server and the in-app assistant (no copy to drift); every write tool's field names, required list, and enums **lock-tested against the API's Zod validators** (`z.toJSONSchema` introspection — the drift that once made 5 write tools 422 on every call is now CI-impossible); OpenAPI request bodies for the core entities **generated from the same Zod schemas**; `llms.txt` covered by its own spec-coverage drift test; registry expanded with `get_*`/`update_*`/`search_workspace` (the governed Kanban move is now agent-reachable) under the unchanged least-privilege scope ceiling; repo-root `.mcp.json` for zero-config Claude Code pickup. — **DONE**
- **R-28** Mainline portfolio timeline — one governed `GET /api/timeline` assembling the cross-project graph (lanes/nodes/edges/critical-path) + a real task-dependency DAG seed. — **PARTIAL** (feed + dependency data shipped; the Subway/Journal/Network switcher UI deferred)

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
- **R-53** Frictionless demo entry — a "Try the live demo" button on the public landing page signs a cold visitor into the seeded demo account in ≤2 clicks / <30 seconds with no signup, via a server-side `POST /api/auth/demo-login` endpoint (credentials in server-only env vars `DEMO_EMAIL` / `DEMO_PASSWORD`; no keys exposed client-side; session audited normally; demo workspace is writable — reseed with `npm run seed:all` to reset). — **DONE**

## Quality & release
- **R-60** vitest unit + governance-invariant tests — token hashing/scopes; requireScope token+user/viewer; four-eyes self-approval; BYOK crypto (round-trip/tamper/wrong-key); assistant token scopes (can request but never approve a delete); document storage path-safety; **scope registry validation; EVM math (both SPI modes + divide-by-zero); admin-client workspace-isolation guard; OpenAPI route-coverage drift; assistant tools↔OpenAPI least-privilege guard**. — **DONE** (267/267 green; `npm test`)
- **R-61** Playwright E2E = AI-orchestrated UAT (agent drives suite vs checklist). — **TODO** (stretch goal)
- **R-62** Deploy to Vercel + Cloudflare DNS (stillnotbald.com); seed live. — **DONE** (live on stillnotbald.com; migrations + seed applied; `apply-migrations.mjs` + `migrate.mjs`)
- **R-63** Mobile usability — the console and marketing surface are fully usable at 390px: Kanban horizontal scroll + touch drag + keyboard operability, command-palette mobile entry, toast/bottom-nav clearance, responsive landing nav/hero, heatmap overflow containment. — **DONE**

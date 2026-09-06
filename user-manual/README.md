# User Manual — index

**Status: ACTIVE** · Written against the console UI and routes as they exist in this repo (`web/src/app/(console)/**`), verified page-by-page, not from spec. If a page or flow described here stops matching the app, the app is the source of truth — file a correction, don't trust this index blindly.

This folder does not restate facts owned elsewhere. Env vars → `web/.env.example`. Install/deploy procedure → [`CUTOVER/`](../CUTOVER/README.md). Requirements/traceability → `requirements/`. Ops runbooks (seat provisioning, backup/restore drills) → [`docs/runbooks/`](../docs/runbooks/README.md).

## Audience split

NoPM has three distinct audiences, each with its own entry point below:

| Audience | Who | Start here |
|---|---|---|
| **Console operator** | A person doing day-to-day project work in the browser — creating tasks, moving the board, requesting deletions, reading the audit trail. | [`operator/00-first-ten-minutes.md`](operator/00-first-ten-minutes.md) |
| **Workspace admin** | A person who provisions the workspace itself — roles, PATs, MFA, seats. | [`admin/01-workspace-admin.md`](admin/01-workspace-admin.md) |
| **Agent surfaces** | An AI agent (or the human configuring one) driving NoPM over the REST API — CLI, MCP, or the in-app BYOK assistant. | [`agents/README.md`](agents/README.md) |

## Status table

| Doc | Status | Covers |
|---|---|---|
| [`operator/00-first-ten-minutes.md`](operator/00-first-ten-minutes.md) | ACTIVE | The 5-step getting-started checklist (also live at `/start`), the Essentials sidebar, the CLI/curl quickstart |
| [`operator/01-getting-started.md`](operator/01-getting-started.md) | ACTIVE | Login (incl. demo funnel), the console shell/nav, My Work |
| [`operator/02-projects-and-tasks.md`](operator/02-projects-and-tasks.md) | ACTIVE | Creating a project, Kanban drag-is-audited, task fields (checklist, acceptance criteria, etc.) |
| [`operator/03-schedule-and-lock.md`](operator/03-schedule-and-lock.md) | ACTIVE | Gantt, dependency types + lag, lock semantics, rebaseline flow, the `/baselines` nav page |
| [`operator/04-approvals-and-trust.md`](operator/04-approvals-and-trust.md) | ACTIVE | Four-eyes deletion requests (incl. withdraw), Approvals page, Trust Center, blocked-attempt rows, 429 |
| [`admin/01-workspace-admin.md`](admin/01-workspace-admin.md) | ACTIVE | Roles, PAT minting/revoking + scopes, MFA, seat provisioning pointer |
| [`agents/README.md`](agents/README.md) | ACTIVE (pointer only) | CLI, MCP server, `/llms.txt`, BYOK assistant — orientation + links, not copies |

## What this manual is not

- Not the API reference — that's the [OpenAPI spec](../web/src/app/api/openapi.json) (served at `/api/openapi.json`) and [`/llms.txt`](../web/src/app/llms.txt).
- Not the install/deploy procedure — that's [`CUTOVER/`](../CUTOVER/README.md).
- Not a restatement of scope decisions — see `requirements/REQUIREMENTS.md` and `requirements/devops-wave1/README.md` for what's in/out and why.

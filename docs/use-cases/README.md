# NoPM use-case catalogue

This catalogue reverse-engineers NoPM's behavior into a set of use cases, written from the outside in: what an actor wants to do, which touchpoint they use (console page, REST endpoint, CLI command, or MCP tool), and what NoPM actually enforces along the way. It exists to give a reader (a hiring manager, an engineer evaluating the codebase, or a future contributor) a use-case-first map of the product, instead of a feature list. Every claim in every file is checked against the source in this repo: route handlers under `web/src/app/api/**`, the canonical requirements register (`requirements/REQUIREMENTS.md`), the user manual (`user-manual/`), the CLI and MCP references (`cli/README.md`, `web/mcp/README.md`), and the agent-facing endpoint index (`web/src/app/llms.txt/route.ts`). Where a detail could not be confirmed from code, the use-case file says so with an explicit `[UNVERIFIED]` marker rather than guessing.

## Actor glossary

| Actor | Who they are in NoPM | Notes |
|---|---|---|
| **Admin** | A signed-in user with `profiles.role = admin`. | At the API-guard layer (`web/src/lib/auth/guard.ts`), admin, manager, and member are currently enforced identically as full-write; there is no granular admin-vs-manager split yet (`user-manual/admin/01-workspace-admin.md`). Admin is the role that mints/revokes tokens, sends invites, and is the de facto workspace owner. |
| **Project Manager** | A signed-in user with `role = manager` or `member` doing day-to-day delivery work: creating projects, planning tasks, raising risks and change requests. | Same write permissions as admin at this build's enforcement level; the label describes function, not a distinct permission tier. |
| **Approver / second pair of eyes** | Any actor, human or token, holding the specific decision scope for a governed action (`task:delete:approve`, `project:delete:approve`, `change:decide`, `rebaseline:approve`) who is a different **person** from the requester. A token counts as the person who minted it. Approval scopes are granted by exact name; a `<resource>:*` wildcard never grants them. | The database enforces that requester and decider are different people on every one of these flows; this is not a role, it is a runtime relationship between two people. |
| **Team member** | A signed-in user with `role = member` doing assigned work: moving Kanban cards, updating task fields. | |
| **Finance / PMO** | A consumer of budget, variance, and board-pack reporting. | Not a distinct role in the schema; anyone with `budget:read` (console access or a scoped token) can act as this actor. |
| **Viewer** | A signed-in user with `role = viewer`. | Strictly read-only: `requireScope` rejects any non-read action for a viewer with `403`, regardless of which endpoint. The public demo login is a manager, not a viewer (`web/scripts/seed-members.mjs` promotes it), so the demo can decide other people's work but not its own. |
| **AI agent via token** | An MCP client, the `nopm` CLI, or the BYOK assistant, all driving the REST API through a scoped `npm_` Bearer PAT (or, for the assistant, a fresh ephemeral token minted per turn). | Bounded strictly by whatever scopes the token holds; never trusted beyond that regardless of surface. |
| **Self-hoster / operator** | A person standing up or maintaining a non-managed instance of NoPM (migrations, backups, disaster recovery). | The app layer ships (`docker-compose.yml`, `web/Dockerfile`, `npm run setup`, R-88). Running your own Supabase stack in place of the managed one is documentation only (`docs/SELF_HOSTING.md`, ADR 0010). |

## How to read the catalogue

Each use case is one file, `UC-NN-<slug>.md`, with a fixed structure: Goal, Actors, Preconditions, Trigger, Main flow (numbered, each step naming the exact touchpoint and the scope it requires), Alternate/exception flows, Postconditions (audit actions written, what the Trust Center shows), Reporting and evidence, and Traceability (R-IDs, files, tests). Steps cite the REST method and path, the MCP tool name, the CLI command, or the console page path, whichever is the actual mechanism, plus the scope required. A diagram link points at the matching BPMN-style flow under `docs/processes/` where one exists (eight flows today; see `docs/processes/README.md`).

## Catalogue

| UC-ID | Name | Primary actor | Outcome served | Modules | R-IDs | Diagram |
|---|---|---|---|---|---|---|
| [UC-01](UC-01-workspace-program-project-setup.md) | Workspace, program, and project setup | Admin / Project Manager | presentable multi-project | Workspace, Program, Project | R-06, R-10, R-71 | — |
| [UC-02](UC-02-milestone-and-task-planning.md) | Milestone and task planning with dependencies | Project Manager | presentable multi-project | Milestone, Task | R-11, R-12, R-33 | — |
| [UC-03](UC-03-kanban-governed-status-change.md) | Kanban move as a governed status change | Team member | governance | Task | R-32, R-01 | — |
| [UC-04](UC-04-risk-register.md) | Risk register: raise, mitigate, close | Project Manager | presentable multi-project | Risk | R-13 | — |
| [UC-05](UC-05-issue-register.md) | Issue register: log, triage, resolve | Team member / Project Manager | presentable multi-project | Issue | R-14 | — |
| [UC-06](UC-06-clash-detection-and-resolution.md) | Clash detection and resolution | Project Manager / Resource owner | governance | Clash, Resource | R-15, R-16 | — |
| [UC-07](UC-07-resource-capacity-and-allocation.md) | Resource capacity and allocation | Resource owner / Finance-PMO | presentable multi-project | Resource | R-16, R-44 | — |
| [UC-08](UC-08-timesheet-submit-approve-period-close.md) | **Withdrawn 2026-10-17 (owner decision 18):** Timesheet submit, approve, and period-close | Team member / Approver | governance | Resource, Timesheet | R-17, R-74, R-76 | [`timesheet-lifecycle-flow.html`](../processes/timesheet-lifecycle-flow.html), [`period-close-reopen-flow.html`](../processes/period-close-reopen-flow.html) |
| [UC-09](UC-09-budget-and-variance-reporting.md) | Budget tracking and variance reporting | Finance / PMO | easier reporting | Budget | R-18 | — |
| [UC-10](UC-10-change-request-raise-and-decide.md) | Change request: raise and decide | Project Manager / Approver | governance | Change Control | R-07, R-83 | [`change-request-lifecycle-flow.html`](../processes/change-request-lifecycle-flow.html) |
| [UC-11](UC-11-baseline-lock-and-rebaseline.md) | Baseline lock and rebaseline | Admin/PM / Approver | governance | Project, Gantt | R-04, R-33, R-65 | [`project-lock-rebaseline-flow.html`](../processes/project-lock-rebaseline-flow.html) |
| [UC-12](UC-12-four-eyes-deletion.md) | Task/project deletion via four-eyes approval | Requester / Approver | governance | Task, Project | R-03, R-67 | [`four-eyes-deletion-flow.html`](../processes/four-eyes-deletion-flow.html) |
| [UC-13](UC-13-document-control.md) | Document control with governed file attachment | Project Manager / Team member | presentable multi-project | Documents | R-39 | [`document-control-flow.html`](../processes/document-control-flow.html) |
| [UC-14](UC-14-export-and-board-pack-reporting.md) | Export and board-pack reporting | Finance / PMO | easier reporting | Export, Reports | R-40, R-68 | — |
| [UC-15](UC-15-trust-center-audit-review.md) | Trust Center audit review | Admin / Approver / Viewer | governance | Trust Center | R-35, R-86 | — |
| [UC-16](UC-16-audit-cursor-external-tailing.md) | Audit cursor for external tailing | AI agent via token | agent-operable | Trust Center, API | R-85, R-82 | — |
| [UC-17](UC-17-scoped-token-and-agent-operation.md) | Scoped token minting and agent operation (CLI/MCP) | Admin / AI agent via token | agent-operable | Tokens, MCP, CLI | R-02, R-23, R-25, R-64 | [`agent-token-lifecycle-flow.html`](../processes/agent-token-lifecycle-flow.html) |
| [UC-18](UC-18-byok-assistant-session.md) | BYOK governed assistant session | Team member / Project Manager | agent-operable | Assistant | R-24, R-26 | — |
| [UC-19](UC-19-invite-and-onboarding.md) | Invite and onboarding | Admin / new Team member | frontend flexibility | Invites, Onboarding | R-75, R-78 | [`invite-onboarding-flow.html`](../processes/invite-onboarding-flow.html) |
| [UC-20](UC-20-notification-center-and-my-work.md) | Notification center and My Work | Team member / Approver | easier reporting | Notifications, My Work | R-27, R-37, R-41 | — |
| [UC-21](UC-21-saved-views-and-navigation-modes.md) | Saved views and navigation modes | Project Manager / Team member | frontend flexibility | Registers, Navigation | R-72, R-43, R-78, R-69 | — |
| [UC-22](UC-22-self-host-setup-and-dr-runbook.md) | Self-host setup and disaster-recovery runbook | Self-hoster / Operator | (operational, see note) | Infra / Ops | see file | — |
| [UC-23](UC-23-approve-from-lark.md) | Approve a four-eyes request from Lark | Approver | governance | Integrations, Review Queue | see file | — |
| [UC-24](UC-24-link-lark-account.md) | Link a Lark account | Team member / Approver | governance | Integrations, Identity | see file | — |
| [UC-25](UC-25-lark-weekly-digest.md) | Lark weekly digest | Admin / Project Manager | easier reporting | Integrations, Notifications | see file | — |
| [UC-26](UC-26-calendar-feed-subscription.md) | Subscribe to the milestone calendar feed | Team member / Project Manager | presentable multi-project | Calendar, Milestones | see file | — |
| [UC-27](UC-27-audit-pack.md) | Export an audit pack for a date range | PMO lead / Admin | easier reporting | Change control, Documents, Trust Center | R-138, R-134, R-137 | — |
| [UC-28](UC-28-handover-report.md) | Handover and key-person report | Project Manager / Admin | easier reporting | Handover, Projects, Tasks, Risks, Issues | R-140 | — |
| [UC-29](UC-29-forecast-and-trend.md) | Forecast at completion and project trend | Finance / PMO / Project Manager | easier reporting | Budget, Snapshots | R-144, R-145 | — |
| [UC-30](UC-30-cross-project-dependencies.md) | Cross-project dependencies and contingency | Project Manager / Admin | presentable multi-project | Projects, Portfolio, Mainline | R-147 | — |

\* Diagram exists on disk today under this exact filename.

## Outcome legend (owner-locked scope posture)

NoPM's scope rule (see `CLAUDE.md`, "Scope posture") requires every feature to serve one of: **presentable multi-project** (portfolio/program views and rollups), **easier reporting** (exports, dashboards, board-pack reporting), or **frontend flexibility** (extensible UI plus non-code configuration). This catalogue adds **governance** and **agent-operable** as descriptive tags for use cases whose primary value is the audit/maker-checker backbone or the agent surfaces, since those are constitutional to the product rather than incremental features, but every governance and agent-operable use case still traces back to one of the three owner-locked outcomes in its own file.

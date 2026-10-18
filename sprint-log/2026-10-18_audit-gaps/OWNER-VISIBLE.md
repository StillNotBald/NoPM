# Owner-visible changes — audit-gap programme (CR-2026-10-18-01)

Every row is a change the owner or a user can see, or a change that alters what an existing caller receives. The lead flips **Status** from `planned` to `built` after review. Kind is one of `added`, `removed`, `hidden`, `renamed`, `re-ordered` or `behaviour`.

## Wave 1 — foundation (schema integrity, lean payloads, access review)

| Change | Kind | Where | Why | Agent | Status |
|---|---|---|---|---|---|
| Preset agent token gains `risk:write`, `issue:write` and `project:write`. It never gains approve or decide scopes. Tokens minted from the preset are broader than before. | behaviour | Tokens page, one-click agent preset | Assumption A5 (CR-2026-10-18-01) | W1-B | planned |
| Risk `category` is no longer accepted or returned by the API. It is no longer shown on the risk form or the risks list. | removed | Risk API, risk form, risks list | Assumption A4; K1. Column kept until a later release drops it. | W1-B | planned |
| List routes return a summary by default (projects, risks, issues, tasks, milestones). Callers that relied on full records must ask for `?view=full`. | behaviour | List API routes, and the MCP `list_*` tools | K5: lean payloads | W1-B | planned |
| List routes accept `?view=summary`, `?view=full` and `?fields=<comma list>`. | added | List API routes, and the MCP `list_*` tools | K2, K4: callers choose the fields they need | W1-B | planned |
| People panel gains an **Export people (CSV)** button. The button renders for anyone who can open the panel. Only an admin or manager session can export; a member who clicks gets a 403. | added | Settings → People panel | M5, M3 (export half) | W1-C | planned |
| Members export is refused for member-role users with a message that names the permission needed. | behaviour | Members export address | M5: access review | W1-C | planned |
| Tokens page gains an **Export tokens (CSV)** button. The file lists labels, scopes and dates, never the token value. Admins only. | added | Tokens page | M3 (export half) | W1-C | planned |
| Trust Center audit CSV gains a `principal_id` column. The column names the human behind an agent or token action. | added | Trust Center → Audit export | M3 audit CSV columns; K3 traceability | W1-C | planned |
| The project lock badge names the person or token that locked the project. | behaviour | Project header lock badge | M7: lock integrity | W1-A | planned |
| Existing locks gain their locker from the audit history. Locks with no audit row show the label "legacy lock (locker not recorded)". | behaviour | Project lock badge, for locks made before this release | M7 backfill of `locked_by` from audit rows | W1-A | planned |
| Unlock refused for members now says who can unlock (managers and admins) instead of a generic refusal. | renamed | Unlock error message | M7 | W1-A | planned |
| Lock and unlock attempts through an agent token record the token label as the locker. | behaviour | Lock API and the audit trail | M7; assumption A6 keeps lock semantics | W1-A | planned |
| People page gains a second button, **Export chat links (CSV)**. | added | Settings → People panel | M3 (export half) | W1-C | planned |
| Export gains a new `identities` entity (CSV). | added | Export API | M3 (export half) | W1-C | planned |
| Every export entity accepts `from`, `to` and `on` date-range filters. | behaviour | Export API, all CSV entities | M3 (export half) | W1-C | planned |
| The audit CSV gains five columns, not only `principal_id`. | added | Trust Center → Audit export | M3 audit CSV columns | W1-C | planned |
| Risk form: the single Impact Area dropdown becomes a checkbox group (several areas per risk). | behaviour | Risk create and edit form | K1, K2: `impact_areas[]` | W1-B | planned |
| Risk form: the "Category (free text)" field is removed. | removed | Risk create and edit form | Assumption A4 | W1-B | planned |
| Risk register gains an "Impact area" filter (single select). The risks page accepts `?impact_area=a,b` to match any of the listed areas. | added | Risks register page and risks list API | K2 | W1-B | planned |
| Risk detail: the label "Impact Area" is renamed "Impact Areas" and shows a comma list. | renamed | Risk detail page | K2 | W1-B | planned |
| Project Risks tab sub-line shows `risk_category` in place of `category`. | behaviour | Project Risks tab | Assumption A4 | W1-B | planned |
| CLI: all `ls` commands send `view=full`, so CLI output is unchanged. | behaviour | CLI `ls` commands | K5: lean payloads | W1-B | planned |
| CLI: new flags `--risk-category` and `--impact-area a,b`. | added | CLI risk commands | K1, K2 | W1-B | planned |
| CLI: the `--category` flag is removed. | removed | CLI risk commands | Assumption A4 | W1-B | planned |
| MCP `create_risk` and `update_risk` gain `risk_category` and `impact_areas` parameters. | added | MCP server tools | K1, K2 | W1-B | planned |
| New audit action `four_eyes.legacy_requester_unknown` appears in the Trust Center stream. It is written only when a legacy approval has no known requester. | added | Trust Center activity stream | M1 audit completeness | W1-C | planned |
| Token unlock refusal has its own text: "Agents and API tokens cannot" unlock. | renamed | Unlock error message for tokens | M7 | W1-A | planned |
| Database: a locked project can no longer exist without a locker (CHECK). Unlock clears the locker. | behaviour | Project lock state, all unlock paths | M7 lock integrity | W1-A | planned |
| Hard-deleting a risk or issue needs the new `risk:delete` or `issue:delete` scope. The agent preset can lock a project but never unlock or delete. | behaviour | API scopes and Tokens page help text | Wave 1 fix pass: scope boundary | W1-B | planned |

## Wave 2 — change-request evidence chain

Rows added when wave 2 starts.

| Change | Kind | Where | Why | Agent | Status |
|---|---|---|---|---|---|
| Change request gains a "Mark implemented" action on an approved request, with an optional note. Requester, manager or admin only. It records the date and person and cannot be done twice. | added | Change Control, request detail | M2, assumption A2 | W2-A | planned | planned |
| New status "Implemented" appears on change requests, with its own filter chip and count. An implemented request can no longer be edited or deleted. | added | Change Control list and detail | M2 | W2-A | planned | planned |
| The earlier answer "remove implemented" is superseded: `implemented` is back as an explicit action, not an automatic status. | behaviour | Change request statuses | Assumption A2 | W2-A | planned | planned |
| Change request gains "Impact by area" (scope, schedule, cost, quality, resources, compliance, each increase / decrease / neutral, with a note). Free-text impact summary stays. Editing it on a pending request re-issues the approval card. | added | Change request form and detail | B2 | W2-A | planned | planned |
| Decision form gains a Change request picker and an options list with one "Chosen" option. The decision detail and the change request detail show the link ("Decisions: n"). Free-text options stay. | added | Decisions, Change Control | B1 | W2-A | planned | planned |
| Change request detail gains an Evidence panel (type, result, tester, date, link) with "Attach evidence". Document form gains an Evidence section; the document viewer shows it. | added | Change Control, Documents | M4 | W2-B | planned | planned |
| Documents can be filtered by change request through the API; evidence fields are refused without a change request. | behaviour | Documents API | M4 | W2-B | planned | planned |
| New "Audit pack" button with a date range, CSV or PDF, for admin and manager only. | added | Change Control page, Trust Center | M3 | W2-C | planned | planned |
| Export gains a `change_requests` entity (CSV) with approver, decision, impact, implemented date, evidence counts and linked decisions. | added | Export API | M3 | W2-C | planned | planned |
| Every audit pack download is recorded in the audit trail as "export.audit_pack". | added | Trust Center activity stream | M3 | W2-C | planned | planned |
| New read-only AI tools: list change requests, get one, list decisions, get a document, get earned-value numbers. The assistant scope ceiling gains read access to decisions and documents only. No tool can decide or approve. | added | MCP server, in-app assistant | B7 | W2-D | planned | planned |
| New read-only addresses: list change requests, list decisions, project earned-value numbers. Lists are lean by default. | added | API | B7 | W2-D | planned | planned |
| Migrations 0092, 0093, 0094 must be applied before the new build is deployed. | behaviour | Release | Release order | lead | planned | planned |

## Wave 3 — runs without you

Rows added when wave 3 starts.

| Change | Kind | Where | Why | Agent | Status |
|---|---|---|---|---|---|
| Projects, risks, issues and tasks gain an optional backup (Backup owner or Backup assignee). A backup must be a different person from the owner or assignee. | added | Project, risk, issue and task forms; their API | M6 | W3-A | planned |
| A project with no backup owner shows a "No backup owner" badge on its header. | added | Project header | M6 | W3-A | planned |
| New **Handover** page in the Portfolio section: open items with an owner and no backup, unowned items, and a key-person list flagging a single point of failure. It exports as CSV. | added | Navigation, Handover page | M6 | W3-A | planned |
| New read-only AI tool `get_handover_report`, in the MCP server and the in-app assistant. | added | MCP server, in-app assistant | M6 | W3-A | planned |
| Migration 0095 must be applied before the new build is deployed. | behaviour | Release | Release order | W3-A | planned |
| Integrations page gains a **Nudges and weekly report** card beside the time zone: stale threshold in days (default 14), nudges on or off, weekly report on or off, and its weekday. | added | Integrations settings | A3, A4 | W3-B | planned |
| Open tasks, risks and issues with no update for the stale threshold get one in-app notification each, to their assignee or owner. Each item is nudged at most once a day and not again within 7 days. | added | Notifications | A4 | W3-B | planned |
| The Kanban stale flag follows the workspace threshold instead of a fixed 14 days. | behaviour | Kanban board | A4 | W3-B | planned |
| The Lark weekly digest card gains a "Stale items" line when there are stale items. | added | Lark weekly digest | A4 | W3-B | planned |
| A weekly status report is stored and sent on the configured weekday. Every admin and manager gets a notification that links to the report. | added | Notifications, Reports | A3 | W3-B | planned |
| The weekly report is an HTML page with project codes, milestones due in 14 days and the stalest items. It is readable at phone width. | added | Reports (API) | A3 | W3-B | planned |
| Integrations card gains **Send weekly report now** (admin or manager). It refreshes this week's report and notifies the same people. | added | Integrations settings | A3 | W3-B | planned |
| New API scope `report:read` for the weekly report. It is not privileged. | added | API scopes, Tokens page | A3 | W3-B | planned |
| New **What changed** page in the Portfolio section: the audit trail across all projects, newest first, grouped by day, 50 per page, with filters for project, kind, person and date. | added | Navigation, What changed page | A5 | W3-B | planned |
| Email previews gain the weekly report and stale-item samples. Nothing is sent. | added | Email previews | A3, A4 | W3-B | planned |
| Migration 0096 must be applied before or with the new build. Without it, saving the new settings fails. | behaviour | Release | Release order | W3-B | planned |
| Budget page gains a **Forecast and trend** card per project: the classic forecast, a forecast of spent plus committed plus the amount still to spend, a to-finish input and a method selector. | added | Budget page | B3 | W3-C | planned |
| The EVM table names the forecast method beside EAC. The budget CSV gains three columns: EAC (CPI), EAC (bottom-up) and forecast method. | added | Budget page, budget CSV | B3 | W3-C | planned |
| The to-finish estimate and the forecast method can be changed on a locked project without a change request. Other budget fields still need one. | behaviour | Budget API and page | B3 | W3-C | planned |
| Budget page shows a **Suggested RAG** beside the declared RAG, with its reason and the line "Advice only; the declared RAG is yours to set". The declared RAG is never changed by the suggestion. | added | Budget page | B6 | W3-C | planned |
| A nightly snapshot of each project is taken, so a trend and a suggestion appear from the next morning. Confidence reads low until three snapshots exist. | added | Scheduler, Budget page | B6 | W3-C | planned |
| Approvals page gains an **All / Mine** control, with counts. **Mine** shows requests assigned to you. | added | Approvals page | G5 | W3-C | planned |
| Change requests, rebaselines and deletion requests can name an approver (an admin or manager other than the requester). Nothing is assigned automatically. | added | Raise routes (API) | G5 | W3-C | planned |
| MCP tool `list_pending_approvals` gains a `mine` parameter. The lead applies it from the W3-C tools note. | added | MCP server | G5 | W3-C | planned |
| Migrations 0097 and 0098 must be applied before the new build is deployed. | behaviour | Release | Release order | W3-C | planned |
| Project page gains a **Project dependencies** panel: what the project depends on and who depends on it, with an Add dependency form (project, kind, optional risk, note) and Remove. | added | Project page | B5 | W3-D | planned |
| Portfolio roadmap shows an amber "Contingent" tag next to a project that is not red but depends on a red one; the tooltip names the red project. The project's own health colour and label do not change. | added | Portfolio | B5 | W3-D | planned |
| Mainline Network lens lists project-to-project dependencies under the task graph; its caption now says project dependencies are included. | added, renamed caption | Mainline | B5 | W3-D | planned |
| A project can no longer depend on itself, on a project in another workspace, or in a loop. | behaviour | Project API | B5 | W3-D | planned |
| Migration 0099 must be applied before the new build is deployed. | behaviour | Release | Release order | W3-D | planned |
| Menu gains **What changed** (`/changes`), placed after Mainline, and **Handover** (`/handover`), placed after Projects. | added | Navigation | M6, A5 (F23) | W3-A, W3-B | planned |
| Budget page portfolio line is relabelled "Forecast (EAC, by CPI)", so it is not read as the bottom-up figure. | renamed | Budget page, portfolio line | B3 (F23) | W3-C | planned |
| The EVM table on the Budget page shows the forecast method on each row. | added | Budget page, EVM table | B3 (F23) | W3-C | planned |
| Approvals rows assigned to you carry an "assigned to me" cue. | added | Approvals page | G5 (F23) | W3-C | planned |
| Bell and email previews gain two notification types: "Needs an update" (stale item) and "Weekly report". | added | Notifications, Email previews | A3, A4 (F23) | W3-B | planned |
| Project API accepts and returns `backup_owner_id` and `backup_assignee_id`, and accepts `assigned_approver_id` on change requests, rebaselines and deletion requests. | added | Project, risk, issue and task API | M6, G5 (F23) | W3-A, W3-C | planned |
| `GET /api/review?mine=1` returns only the requests assigned to the caller. | added | Review API | G5 (F23) | W3-C | planned |

## Wave 4 — governance tiers, deletion flow, atomic audit, work events

Rows added when wave 4 starts. Assumptions A1, A3 and A8 land here.

| Change | Kind | Where | Why | Agent | Status |
|---|---|---|---|---|---|
| Settings gains an **Approval policy** card: for each of the five tiers, who decides it and its turnaround hours, a routine-only auto-approve checkbox with a warning, the cost threshold, the currency and the emergency retro window. The rows stack at phone width. | added | Settings, Approval policy card | G1, G2, G7; A3 | W4-A | planned |
| Change requests show a tier badge: Routine, Normal, High risk, Strategic or Emergency. The raise form has a tier choice. Routine is offered only with no cost and no schedule impact. | added | Change Control list, detail and raise form | G1 | W4-A | planned |
| A cost at or over the threshold (default 50,000) makes a normal change request High risk. The requester cannot lower it. | behaviour | Change Control raise form | G7; A3 | W4-A | planned |
| A manager can no longer decide a High risk or Strategic change, and the card says "This request needs an admin to decide it." The same rule applies to the approve button on a Lark card. | behaviour | Change Control, Approvals, Lark approval card | G2; A3 | W4-A | planned |
| A project deletion now needs an admin by default, because it is High risk. The workspace policy can move it back to managers. | behaviour | Project deletion approvals | G1; A3 | W4-A | planned |
| Each waiting request shows its approval deadline. Approvers are reminded at half the turnaround, and admins are told past the deadline. | added | Approvals page, notifications | G3; A1 | W4-A | planned |
| Routine auto-approve is in the policy card and is OFF by default. When an admin turns it on, a routine change nobody decides by its deadline is approved by policy, and the requester is told. | added | Settings, Approval policy card | G3; A1 | W4-A | planned |
| **Emergency** tick box on the change raise form for managers and admins. An emergency shows status Emergency, a retro deadline and no ordinary deadline. It can be marked implemented at once, and an admin gives the retro decision. | added | Change Control raise form and detail | G4; A3 | W4-A | planned |
| An emergency whose retro decision is overdue is marked in red, and it appears in the Approvals queue, the digest and the weekly report ("Emergency changes overdue for approval"). | added | Approvals, Lark digest, weekly report | G4 | W4-A | planned |
| Audit pack CSV gains the columns tier, is_emergency, retro_due_at, retro_decided_at, retro_outcome and retro_overdue on change requests. | added | Trust Center audit pack | G4 | W4-A | planned |
| Workspace settings API gains `approval_policy` on read and write (admin only for write). | added | Workspace settings API | G2, G7 | W4-A | planned |
| Deleting a risk, issue, expense, document or milestone now creates a deletion request (answers 202) instead of removing it. Another person must approve it. | behaviour | Risks, Issues, Budget (expenses), Documents, Milestones | G8; A8 | W4-B | planned |
| The milestone page shows **Request deletion** with a reason dialog, and **Deletion requested** while the request waits. The dialog stacks at phone width. | renamed, added | Milestone detail | G8 | W4-B | planned |
| The Approvals page lists five new kinds: risk, issue, expense, document and milestone deletion. Each shows what approving also removes, such as a milestone's tasks. | added | Approvals page, review queue | G8 | W4-B | planned |
| An approved document can be deleted on request only by an admin. | behaviour | Documents | G8; decision 25 | W4-B | planned |
| A milestone deletion is refused while its project is locked, and refused if its task count changed after the request. | behaviour | Milestone deletion | G8 | W4-B | planned |
| The database refuses a direct delete of risks, issues, expenses, documents and milestones unless an approved request commits it. The dev seed script that deletes documents fails by design. | behaviour | Database, dev scripts | G8 | W4-B | planned |
| Tokens that deleted these records before need the new request scopes (risk, issue, expense, document, milestone), granted by exact name. Approving needs the matching approve scope. | behaviour | API scopes, Tokens page | G8 | W4-B | planned |
| CLI remove commands for these records take `--reason`. | added | CLI | G8 | W4-B | planned |
| Every governed change and its audit row now save together. If the audit row cannot be written, the change is not saved. No screen changes. | behaviour | Several (all write screens) | M1 | W4-C1, W4-C2 | planned |
| Trust Center shows a chain line, "Chain verified: n rows, last check <time>", or "Chain broken" naming the first bad row. **Verify now** is for admins and managers. | added | Trust Center | M1; A7 | W4-C2 | planned |
| Each **Verify now** adds one `audit.verified` row to the audit log. | behaviour | Audit log | M1 | W4-C2 | planned |
| The audit CSV export gains a last column, `row_hash`. Audit API rows gain `prev_hash`, `row_hash` and `chain_seq`. | added | Audit export, audit API | M1; A7 | W4-C2 | planned |
| New audit channel `github`, shown in the channel filter and export. | added | Trust Center, Audit | A1 | W4-D | planned |
| **GitHub** card on the Integrations page: connect (the secret is shown once), webhook address, pause and resume, the status each event moves a task to, rotate the secret, revoke, and the last 20 events with their result. | added | Integrations page | A1 | W4-D | planned |
| Task detail panel gains a **Link PR** field. It stores a pull request as `owner/repo#number`, and it is validated. | added | Task detail panel | A1 | W4-D | planned |
| A task linked to a pull request moves when the pull request opens or merges, or when a deployment succeeds or fails. It never moves on a locked project, and never moves backwards. | added | Tasks, Kanban board | A1; A6 | W4-D | planned |
| Migrations 0100 and 0101 must be applied before the new build is deployed. Migration 0102 must be applied in the same window as the build, because an old build's direct delete fails once it is live. Migration 0104 holds a lock on the audit log while it hashes existing rows. | behaviour | Release | Release order | lead | planned |
| Migrations 0103, 0104 and 0105 must be applied before the new build is deployed. | behaviour | Release | Release order | lead | planned |
| After release an admin connects the GitHub repository webhook on the Integrations page. Nothing is connected until then. | behaviour | Release | Release order | lead | planned |

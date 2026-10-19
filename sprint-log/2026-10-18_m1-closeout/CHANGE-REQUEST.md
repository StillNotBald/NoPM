# CR-2026-10-18-02: M1 close-out and agent evidence

| Field | Value |
|---|---|
| Raised by | Lead session, from the v2 audit report (`_docs/directions-2026-10-17/NOPM_AUDIT_REPORT_v2.md`, section 3) |
| Source decision | Owner Q8, CR-2026-10-18-01: "Different DB" for the audit-chain head |
| Category | Audit integrity + Agent surface + Governance |
| Status | PROPOSED. Scope is the audit's own list (revision 2 after the plan review). Five owner decisions (D8, D9, D15, D18, D19) and assumptions A9 to A16 below await her. Builders use the recommended defaults until she answers; the other former decisions are now builder defaults and need no answer. |
| Positioning served | "Leaves the evidence auditors ask for": every change atomic, the trail anchored outside the database, evidence reachable by the agent |

## Scope

Everything the v2 report still rates PARTIAL or MISSING, except Slack/Teams and OAuth (need the maintainer), Q2 and UAT-018 (owner has not answered).

| Item | What | Wave |
|---|---|---|
| M1a | 24 write-then-audit handlers move onto the atomic path (8 governance, 12 security and integration, 4 unattended jobs). Only 2 can use the generic wrapper; the other 22 use dedicated functions that share one audit-insert helper | 1a, 1b |
| A2 | Optional blocker reason and ETA on tasks | 1a |
| M5 | Last sign-in column in the members export (admin only) | 1a |
| M1b | Audit-chain head anchored in a second database; verify compares; Trust Center and the audit pack cover show it | 2b |
| M4, M2, B7, B1 | MCP: attach evidence, implement, decision link, rebaseline history, document list, dependency list | 2a |
| G8 | Deletion by request for programs, sprints, resources, allocations, clashes (trigger step applied after the deploy) | 2a |
| G4, S5 | Retro leftovers removed; seed logins on a neutral domain | 3 |
| G6, M2, K3 | Owner-run read-only SQL checklist for constraint validation, locks, 0106 counts | 3 |

Outcome mapping (CLAUDE.md scope posture): M1, M4, M5, G8 serve outcome 2 (audit evidence, easier reporting); the MCP items and A2 serve the agent surface; the anchor is the audit moat.

## Impact

| Area | Impact |
|---|---|
| Schema | migrations 0107 to 0114, additive and idempotent. 0107 adds a shared audit-insert helper. 0108 to 0110 add functions (no table change except a small entity-map table in 0108). 0111 adds two nullable task columns. 0112 adds a local receipts table (RLS on). 0113 extends the deletion CHECKs and commit functions, and makes the task commit function set the deletion flag. **0114 adds the delete-refusing trigger to five more tables and is applied AFTER the deploy.** It is the only change with live-data risk: a code path that still hard-deletes would start failing, so every cascading commit function is listed and probed first. |
| Second database | New: one external Postgres holding an append-only `audit_anchors` table, read and written through `NOPM_ANCHOR_DB_URL` with the already-approved `pg` package (a local type shim, no new package). Unset means "not anchored", never an error. |
| API | new `POST /api/change-requests/:id/evidence`; `GET /api/audit/verify` payload gains `anchor`, and `audit.verified` rows record the anchor state; **five `DELETE` routes change from 204 with no body to 202 with the deletion request (decision D19)**; task create and update accept two optional fields and the task views always carry them; members export gains one column (admin). There is no manual anchor route. |
| MCP | about 12 new tools or fields: `attach_evidence`, `implement_change_request`, `list_rebaselines`, `get_baseline_history`, `list_documents`, `list_project_dependencies`, five `request_*_deletion`, and new fields on `create_document`, `create_decision`, `create_task`, `update_task`. Each maps to an existing route. |
| UI | Trust Center anchor status and an anchor line on the audit pack cover; "Request deletion" buttons on five registers; two optional task fields; Approvals shows five new kinds. No chat approval card for the new kinds. |
| Behaviour that must NOT change | audit action names and `before`/`after` shapes (auditors' tooling), response bodies and codes of the 24 converted handlers, MFA lockout rules |
| Security boundary | the anchor database holds only hashes and counts, no business data. Its role can insert and select, never update or delete. Credentials are separate from the primary database. |
| Live data | nothing destructive. 0114 changes only what can be deleted, not existing rows. |
| Cost | one small external Postgres (free tier is enough: one row per workspace per day) |

## Owner assumptions (built as stated; flag any you want changed)

| # | Assumption | Why |
|---|---|---|
| A9 | The anchor database uses the `pg` package already approved for the migration runner, now also at runtime (typed by a local shim, not `@types/pg`), plus one extra managed database. Both are covered by Q8 "Different DB". | CLAUDE.md asks before a new dependency or infra dependency. |
| A10 | A successful anchor writes no `audit_log` row. Failures and mismatches (one per streak each) and the first or recovery anchor of a workspace do; every verify records the anchor state inside its own `audit.verified` row. | An audit row per anchor moves the head and chases itself. The anchor table is the evidence. |
| A11 | Anchors are per workspace, keyed by `(workspace_id, chain_seq)`. | The chain is per workspace. |
| A12 | The 24 conversions keep every audit action name, `before`/`after` shape, status code and response body. | Auditors and the CSV/PDF audit pack depend on them. |
| A13 | `last_sign_in_at` comes from the auth user record, appears only in the export and only for admins; a manager's export omits the column. A member who never signed in has an empty cell. | M5 asks for admin-only access review data. |
| A14 | Blocker reason and ETA follow the normal task rules: blocked on a locked project, audited as `task.update`, no new required field. | A2 says no new required fields. |
| A15 | The agent attaches evidence through a new thin endpoint `POST /api/change-requests/:id/evidence`, never by writing to the database. | Brief rule: every tool maps to a route. |
| A16 | Not in this change request: Slack/Teams, OAuth, B4 per-task baseline history, task backup owner, MCP policy tool, MCP access-review export, Q2, UAT-018, a manual force-anchor route, a chat approval card for the new deletion kinds. | Maintainer-gated, unanswered or outside the requested list. |

## Owner decisions (five; the recommended default is built until she answers)

| # | Decision | Options | Recommended default | What changes if she says no |
|---|---|---|---|---|
| D8 | Anchor failure mode | (a) fail-open for business writes, loud for claims; (b) fail-closed: a failed anchor blocks verify and audit-pack export; (c) fail-closed on writes | (a). A mutation never waits for an outside database. The Trust Center cannot say "anchored" without a successful comparison, and a failed anchor writes one `audit.anchor_failed` row per streak plus a red banner. | (b) adds a staleness limit (for example 14 days) after which audit-pack export refuses. (c) is not recommended. |
| D9 | Which anchor database | (a) a second project at the same provider as the main database, under a separate login and organisation; (b) a different provider's managed Postgres; (c) self-hosted | (a). Free tier, same skills, and a separate login means a stolen main-database admin cannot rewrite the anchor. (b) is stronger against provider-level compromise. She must create the account either way. | Only the connection string and the runbook change. |
| D15 | Deletion tiers and routing for the five new registers | (a) program high risk (admin), sprint, resource, allocation, clash normal (manager), fixed, not editable in Settings; (b) all high risk; (c) allocations and clashes stay audited direct deletes; (d) make the five kinds routable in Settings tier routing | (a). Allocations are routine planning edits, so (c) is a fair alternative; the plan builds all five as asked. Settings routing (d) means a policy-shape change in the validator and card, so it is a follow-up if she wants it. | (b) sends every deletion to an admin. (c) leaves two registers outside G8 and G8 stays PARTIAL. (d) adds a settings change. |
| D18 | `schedule_threshold_days` (her Q3 answer said not required) | (a) keep as built, unused by default; (b) remove | (a). Removing is a policy-shape change that deserves its own line. | (b) removes the field from the policy card and validator. |
| D19 | The five register DELETE routes change from 204 with no body to 202 with the deletion request | (a) accept, flag in the release notes; (b) keep 204 and move the request to a new route | (a). Same status and body as the existing five request routes (`risk`, `issue`, `expense`, `document`, `milestone`); any client of these five routes sees a different status. | (b) adds five routes and breaks the one-DELETE-per-entity pattern. |

## Builder defaults (no answer needed; the obvious option is built)

| # | Topic | Built as | Why it is not an owner decision |
|---|---|---|---|
| D10 | `eta` type | a date, optional, always present (null when unset) in task views | sortable and comparable with the due date; free text goes in `blocker_reason` |
| D11 | Anchor cadence | daily on the existing cron plus on every verify, skipped when the head is already anchored | a weekly cadence leaves a seven-day window; cost is negligible |
| D12 | Anchor role privilege | insert and select, append-only by triggers and grants | a write-only role cannot be read back for the comparison |
| D13 | MFA writes | one dedicated function per MFA transition; the attempt counter stays outside the audit transaction | `user_mfa` has no workspace column; a failing audit must never grant a free guess |
| D14 | Unattended jobs | convert all four | the audit's test is "no change without its audit row" |
| D16 | Deletion request on a clash the system created | a request is required for any DELETE; auto-resolve stays a status change | simplest, matches the trigger |
| D17 | `emergency_retro_hours` | accept and ignore, documented as deprecated | stored data exists |

## Risks

| Risk | Handling |
|---|---|
| Converting 24 live handlers changes behaviour by accident | A12 plus per-route tests asserting unchanged bodies; verifier tries to break each RPC on the local database; the ratchet test only shrinks |
| Trigger on five more tables breaks a code path that deletes (for example approving a task deletion cascades its allocations) | every cascading commit function sets the flag in 0113; the trigger is a separate migration 0114 applied after the deploy; the probe approves a task, project and resource with children before and after 0114; the migration is held back if a path is found |
| Anchor outage | D8 default: fail-open for writes, loud for claims; setup is optional and last in the release |
| Anchor secret leaks | Hashes and counts only; insert and select role; separate login; the connection string lives only in the host environment |
| Unvalidated constraints stay NOT VALID | new migrations raise on validation failure; the owner-run checklist (`CUTOVER/12`) checks `convalidated` live |

## Owner-visible changes

Kept in `OWNER-VISIBLE.md` per wave and summarised in the PR.

## Findings and fixes after UAT

Findings are minted in `UAT-log/01-FINDINGS.md` only, root causes in `02`, retest in `03`. No pass or fail counts in `UAT-log/`; counts go to `testing-log/`.

## Decision raised by the wave-2/3 review (2026-10-19 02:50 MYT)

| Decision | Builder's default (built in the fix pass) | What changes if the owner says no |
|---|---|---|
| D20. Clearing an anchor mismatch after a legitimate restore | The owner inserts one `reset` source row in the anchor database (exact SQL in `CUTOVER/13-AUDIT-ANCHOR.md`); the comparison treats it as a new baseline, and a mismatch that happens after the reset is still reported. The Trust Center shows "re-baselined on <date>". | Keep the red state until the restored log regrows past the old anchor position (no reset path), or require a hand-inserted anchor above the old position. |

UAT note D5 (PATCH `/api/workspace-settings` with only the retired `emergency_retro_hours` answers 422 "nothing to update"): pre-existing contract for an empty update, left as is.

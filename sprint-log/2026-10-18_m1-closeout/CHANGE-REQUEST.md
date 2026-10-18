# CR-2026-10-18-02: M1 close-out and agent evidence

| Field | Value |
|---|---|
| Raised by | Lead session, from the v2 audit report (`_docs/directions-2026-10-17/NOPM_AUDIT_REPORT_v2.md`, section 3) |
| Source decision | Owner Q8, CR-2026-10-18-01: "Different DB" for the audit-chain head |
| Category | Audit integrity + Agent surface + Governance |
| Status | PROPOSED. Scope is the audit's own list; decisions D8 to D18 and assumptions A9 to A16 below await the owner. Builders use the recommended defaults until she answers. |
| Positioning served | "Leaves the evidence auditors ask for": every change atomic, the trail anchored outside the database, evidence reachable by the agent |

## Scope

Everything the v2 report still rates PARTIAL or MISSING, except Slack/Teams and OAuth (need the maintainer), Q2 and UAT-018 (owner has not answered).

| Item | What | Wave |
|---|---|---|
| M1a | 24 write-then-audit handlers move onto the atomic path (8 governance, 12 security and integration, 4 unattended jobs) | 1 |
| A2 | Optional blocker reason and ETA on tasks | 1 |
| M5 | Last sign-in column in the members export (admin only) | 1 |
| M1b | Audit-chain head anchored in a second database; verify compares; Trust Center shows it | 2 |
| M4, M2, B7, B1 | MCP: attach evidence, implement, decision link, rebaseline history, document list, dependency list | 2 |
| G8 | Deletion by request for programs, sprints, resources, allocations, clashes | 2 |
| G4, S5 | Retro leftovers removed; seed logins on a neutral domain | 3 |
| G6, M2, K3 | Owner-run read-only SQL checklist for constraint validation, locks, 0106 counts | 3 |

Outcome mapping (CLAUDE.md scope posture): M1, M4, M5, G8 serve outcome 2 (audit evidence, easier reporting); the MCP items and A2 serve the agent surface; the anchor is the audit moat.

## Impact

| Area | Impact |
|---|---|
| Schema | migrations 0107 to 0112, additive and idempotent. 0107 to 0109 add RPCs (no table change). 0110 adds two nullable task columns. 0111 adds a local receipts table. 0112 adds a delete-refusing trigger on five more tables (the only change with live-data risk: a code path that still hard-deletes would start failing, so the builder must prove there is none). |
| Second database | New: one external Postgres holding an append-only `audit_anchors` table. The app reads and writes it only through `NOPM_ANCHOR_DB_URL`. Unset means "not anchored", never an error. |
| API | new `POST /api/change-requests/:id/evidence`, new `POST /api/audit/anchor`; `GET /api/audit/verify` payload gains `anchor`; five `DELETE` routes change from 200 to 202 (request, not delete); task create and update accept two optional fields; members export gains one column (admin). |
| MCP | about 12 new tools or fields: `attach_evidence`, `implement_change_request`, `list_rebaselines`, `get_baseline_history`, `list_documents`, `list_project_dependencies`, five `request_*_deletion`, and new fields on `create_document`, `create_decision`, `create_task`, `update_task`. Each maps to an existing route. |
| UI | Trust Center anchor status; "Request deletion" buttons on five registers; two optional task fields; Approvals shows five new kinds. |
| Behaviour that must NOT change | audit action names and `before`/`after` shapes (auditors' tooling), response bodies and codes of the 24 converted handlers, MFA lockout rules |
| Security boundary | the anchor database holds only hashes and counts, no business data. Its role can insert and select, never update or delete. Credentials are separate from the primary database. |
| Live data | nothing destructive. 0112 changes only what can be deleted, not existing rows. |
| Cost | one small external Postgres (free tier is enough: one row per workspace per day) |

## Owner assumptions (built as stated; flag any you want changed)

| # | Assumption | Why |
|---|---|---|
| A9 | The anchor database uses the `pg` package already approved for the migration runner, now also at runtime, plus one extra managed database. Both are covered by Q8 "Different DB". | CLAUDE.md asks before a new dependency or infra dependency. |
| A10 | A successful anchor writes no `audit_log` row. Failures (one per streak), mismatches, and the first anchor of a workspace do. | An audit row per anchor moves the head and chases itself. The anchor table is the evidence. |
| A11 | Anchors are per workspace, keyed by `(workspace_id, chain_seq)`. | The chain is per workspace. |
| A12 | The 24 conversions keep every audit action name, `before`/`after` shape, status code and response body. | Auditors and the CSV/PDF audit pack depend on them. |
| A13 | `last_sign_in_at` comes from the auth user record, appears only in the export and only for admins; a manager's export omits the column. A member who never signed in has an empty cell. | M5 asks for admin-only access review data. |
| A14 | Blocker reason and ETA follow the normal task rules: blocked on a locked project, audited as `task.update`, no new required field. | A2 says no new required fields. |
| A15 | The agent attaches evidence through a new thin endpoint `POST /api/change-requests/:id/evidence`, never by writing to the database. | Brief rule: every tool maps to a route. |
| A16 | Not in this change request: Slack/Teams, OAuth, B4 per-task baseline history, task backup owner, MCP policy tool, MCP access-review export, Q2, UAT-018. | Maintainer-gated, unanswered or outside the requested list. |

## Owner decisions needed (D8 to D18; recommended default is built until she answers)

| # | Decision | Options | Recommended default | What changes if she says no |
|---|---|---|---|---|
| D8 | Anchor failure mode | (a) fail-open for business writes, loud for claims; (b) fail-closed: a failed anchor blocks verify and audit-pack export; (c) fail-closed on writes | (a). A mutation never waits for an outside database (that would turn an anchor outage into a NoPM outage). The Trust Center cannot say "anchored" without a successful comparison, and a failed anchor writes one `audit.anchor_failed` row per streak plus a red banner. | (b) adds a staleness limit (for example 14 days) after which audit-pack export refuses. (c) is not recommended. |
| D9 | Which anchor database | (a) a second project at the same provider as the main database, under a separate login and organisation; (b) a different provider's managed Postgres; (c) a self-hosted Postgres | (a). Same skills and tools, free tier, and a separate login means a stolen main-database admin cannot rewrite the anchor. (b) is stronger against provider-level compromise and costs little more. | Only the connection string and the setup runbook change. |
| D10 | `eta` type | (a) a date; (b) free text | (a) a date, optional. Sortable, comparable with due date, and usable in the lean view. A reason that needs words goes in `blocker_reason`. | Free text loses sorting and overdue checks. |
| D11 | Anchor cadence | (a) daily on the existing cron, plus on every verify; (b) weekly as first worded | (a). The cost is one row per workspace per day and a weekly cadence leaves a seven-day window in which the newest rows can be deleted unseen. A head already anchored is skipped, so quiet days cost nothing. | (b) is a one-line cron condition. |
| D12 | Anchor role privilege | (a) insert and select; (b) insert only | (a). A write-only role cannot be read back, so verify could not compare. Append-only is enforced by triggers and grants in the anchor database. Alternative if she insists on write-only: a second read-only role and a second variable `NOPM_ANCHOR_DB_READ_URL`. | (b) with a read variable adds one env var and one role. |
| D13 | MFA writes | (a) one dedicated RPC per MFA transition; (b) allowlist `user_mfa` in the generic wrapper; (c) keep as listed exceptions | (a). `user_mfa` has no workspace column so the generic wrapper does not fit, and the TOTP lockout counter must stay in the same transaction. | (c) leaves four handlers on the exception list and M1 stays PARTIAL. |
| D14 | Unattended jobs (clashes, overspend, snapshots, weekly report) | (a) convert all four; (b) exempt them as "system job, one batch audit row" | (a). The audit's test is "no change without its audit row", and a job can fail between the write and the row too. | (b) drops 4 of 24 and M1 stays PARTIAL on those four. |
| D15 | Deletion tier for the new registers | (a) program high risk (admin), sprint, resource, allocation, clash normal (manager); (b) all high risk; (c) allocations and clashes stay audited direct deletes | (a). Allocations are routine planning edits, so (c) is a fair alternative; the plan builds all five as asked and the choice is one scope line. | (b) sends every deletion to an admin. (c) leaves two registers outside G8 and G8 stays PARTIAL. |
| D16 | Deletion request on a clash the system created | (a) request required for any DELETE; auto-resolve stays a status change; (b) only manual clashes need a request | (a). Simpler and consistent with the trigger on the table. | (b) needs a flag column. |
| D17 | `emergency_retro_hours` setting | (a) accept and ignore, document as deprecated; (b) reject | (a). Existing workspaces may have it stored. | (b) breaks clients that still send it. |
| D18 | `schedule_threshold_days` (owner Q3 said not required) | (a) keep as built, unused by default; (b) remove | (a) for now. Removing is a policy-shape change that deserves its own line. | (b) removes the field from the policy card and validator. |

## Risks

| Risk | Handling |
|---|---|
| Converting 24 live handlers changes behaviour by accident | A12 plus per-route tests asserting unchanged bodies; verifier tries to break each RPC on the local database; the ratchet test only shrinks |
| Trigger on five more tables breaks a code path that deletes | W5-G lists every cascade and code path first and probes them locally; the migration is held back if one is found |
| Anchor outage | D8 default: fail-open for writes, loud for claims; setup is optional and last in the release |
| Anchor secret leaks | Hashes and counts only; insert and select role; separate login; the connection string lives only in the host environment |
| Unvalidated constraints stay NOT VALID | new migrations raise on validation failure; the owner-run checklist (`CUTOVER/12`) checks `convalidated` live |

## Owner-visible changes

Kept in `OWNER-VISIBLE.md` per wave and summarised in the PR.

## Findings and fixes after UAT

Findings are minted in `UAT-log/01-FINDINGS.md` only, root causes in `02`, retest in `03`. No pass or fail counts in `UAT-log/`; counts go to `testing-log/`.

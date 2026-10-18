# 2026-10-18 — audit-gap wave 1: gates + local-database release rehearsal

Build: branch `feat/audit-gaps-2026-10-18`, commit e05a691 (wave 1). Evidence for migrations 0088–0091 and the wave-1 code. Nothing here touched a hosted project; the stack was a local Supabase (Docker) started from `web/supabase/config.toml` with auto-migrations off so the repo's own runner (`scripts/apply-migrations.mjs`) did the applying, exactly as a release does.

## Automated gates (after the review fix pass)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm test` (vitest) | 5483 passed, 1 failed: `src/components/marketing/marketing.test.ts` transcript soft-wrap, a CRLF-checkout artefact (global `core.autocrlf=true`; the regex expects `\n`), present on the untouched clone too |
| `npm run lint` | 0 errors, 13 warnings (pre-existing) |
| `cli` tests | 63 passed |
| `npm run rtm:verify` | OK, 123 R-IDs, 1160 code paths on disk |
| `scripts/commit-gate.mjs` | clean on 75 staged files (after replacing model-family names in prose) |
| graphify (code-only) | 6,618 nodes, 20,961 edges, 283 communities, 0 import cycles |

## Release rehearsal (repo runner, seeded data, simulated legacy rows)

Procedure: empty stack → `apply-migrations.mjs` to 0087 (0092–0094 from wave 2 were also present and applied; they are additive) → `bootstrap.mjs` + `seed:all` → simulate rows the live database may hold: two projects `is_locked = true` with no locker (one with `locked_at` null), four decided change requests with `requested_principal_id` nulled, one of them set to a historical self-approval (requester = decider) under a NOT VALID check, one deletion request with no requester principal and no raise audit row → `apply-migrations.mjs --dry-run` → `--atomic` → probes.

| Check | Result |
|---|---|
| Dry run of 0088–0091 | 4 files applied cleanly in 38 ms, rolled back, ledger unchanged |
| Atomic apply | committed in one transaction, 41 ms |
| 0088 lock backfill | 2 lockerless locks stamped `legacy lock (locker not recorded)`, actor type `token`, `locked_at` filled; CHECK `projects_lock_integrity` VALIDATED |
| 0089 change requests | 3 of 3 null requester principals derived from `change_request.create` audit rows |
| 0089 deletion request (no raise row) | left NULL and counted in the NOTICE; NOT stamped with the decider (the review P0, W1-01) |
| 0089 historical self-approval | `cr_principal_distinct` could not validate: left NOT VALID with a NOTICE, migration continued (W1-02); `deletion_principal_distinct` and `ts_principal_distinct` validated |
| 0091 impact_areas | backfilled from `impact_area`; `max(updated_at)` on risks identical before and after (trigger paused, W1-03) |
| `nopm_lock_project` overloads | 1 |
| `probe-migrations.mjs` | 9/9 PASS (88 files recorded) |
| `probe-four-eyes.mjs` | 28/28 PASS |
| Seed lock step (W1-05) | after unlocking the simulated rows, `seed-mainline-deps.mjs` locks its project with `locked_by`, actor type `user`, a label and `locked_at` |

## Wave 2 rehearsal (same procedure, 0092–0094 held back behind seeded data)

| Check | Result |
|---|---|
| Dry run of 0092–0094 | 3 files applied cleanly in 25 ms, rolled back |
| Atomic apply | committed in one transaction, 26 ms; `cr_implemented_after_decision` VALIDATED |
| Probes | `probe-migrations.mjs` 9/9, `probe-four-eyes.mjs` 28/28 |
| `nopm_implement_change_request` on an approved request | ownerless token → `NO_PRINCIPAL`; non-approved request → `INVALID_TRANSITION`; repeat → `ALREADY_IMPLEMENTED`; row stamped `implemented_at >= decided_at` with principal and label; one `change_request.implement` audit row (before `approved`, after `implemented`) |
| Who-may check (before fix) | A member implemented a request whose `requested_principal_id` was NULL because the function's legacy `requested_by` branch matched their profile id (the review's W2-16). Decision: drop that branch; NULL requester principal → approver role only |
| Historical self-approval row | any UPDATE (including implement) is refused by the NOT VALID `cr_principal_distinct`; such rows are frozen (owner decision; recorded in CUTOVER/11) |

After the fix pass (0092 and 0094 re-rehearsed: dry run 30 ms, atomic 30 ms, probes 9/9 and 28/28), a functional probe of the final SQL:

| Case | Result |
|---|---|
| legacy `requested_by` caller with NULL requester principal | refused `NOT_ALLOWED` |
| another member | refused `NOT_ALLOWED` |
| ownerless token | refused `NO_PRINCIPAL` |
| manager on a NULL-requester request | implemented; `implemented_at >= decided_at`; principal = manager; exactly one `change_request.implement` audit row |
| repeat | refused `ALREADY_IMPLEMENTED` |
| requester by principal | implemented |
| document unlinked from its change request | the five evidence fields cleared by the 0094 trigger |

## Wave 3 rehearsal (0095–0099 held back behind seeded data)

| Check | Result |
|---|---|
| Dry run of 0095–0099 | 5 files applied cleanly in 61 ms, rolled back |
| Atomic apply | committed in one transaction, 60 ms |
| Probes | `probe-migrations.mjs` 9/9, `probe-four-eyes.mjs` 28/28 |
| `project_dependencies` triggers | self-dependency and transitive A→B→C→A refused (`DEPENDENCY_CYCLE`); duplicate refused (unique); cross-workspace refused (`CROSS_WORKSPACE`) |
| Deletion guard | `nopm_project_child_counts` (redefined in 0099) runs and counts dependencies |
| Backup owner | `projects_backup_differs` refuses backup = owner; a different backup is accepted |
| Snapshots / settings | second snapshot on the same day refused (`project_snapshots_project_day_uniq`); `stale_days = 0` refused |
| RLS | enabled on `project_dependencies`, `project_snapshots`, `nudge_log`, `weekly_reports` |
| Write grants | FAILED for `nudge_log`: `anon`/`authenticated` still hold INSERT/UPDATE/DELETE (blocked by RLS-without-policies today, but the 0048 convention revokes them); sent to the wave-3 review |

## Observations for the next review

- Unlocking by direct SQL (`is_locked = false`) clears `locked_by_actor_id` through the 0088 trigger but leaves `locked_at` set. The unlock RPC clears everything; the trigger should too (P2).
- Node 24 on Windows prints `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` at exit of the seed scripts after their work completes. Harmless here; not a product bug.
- With a project locked, `seed-mainline-deps.mjs` is refused by the lock backstop (`PROJECT_LOCKED`) at its first step. Correct product behaviour; the seed is for fresh installs.
- Release order stands: 0088–0091 before the build serves traffic; 0091 is a hard dependency of the risk routes.

### Wave 3 after the fix pass

| Check | Result |
|---|---|
| 0095–0099 re-rehearsed | dry run 63 ms, atomic 63 ms; probes 9/9 and 28/28 |
| Browser-role grants on `project_dependencies`, `project_snapshots`, `nudge_log`, `weekly_reports` | SELECT only (F9 fixed) |
| Deletion guard | one definition; counts `project_dependencies`, excludes `project_snapshots` (F3 fixed) |
| Wave-3 CHECKs | all validated; the only NOT VALID checks left on `project_budget` are the two from migration 0078 (pre-existing) |
| Gates | tsc 0, vitest 6008/6009 (CRLF case only), lint 0 errors, cli 63, rtm:verify OK (137 R-IDs), commit-gate clean (171 files) |

## Wave 4 rehearsal (0100–0105 held back behind seeded data)

| Check | Result |
|---|---|
| Dry run of 0100–0105 | 6 files applied cleanly in 109 ms, rolled back |
| Atomic apply | committed in one transaction, 99 ms (0104's hash backfill included) |
| `probe-migrations.mjs` | 9/9 |
| `probe-four-eyes.mjs` | 26/28: P2 and L3 fail because the probe approves a project deletion with a MANAGER and project deletions now default to the admin tier (CR A3); the refusal text still says "managers and admins". Sent to the wave-4 review (fixture + message) |
| Functional probe (20 checks) | all PASS: `DELETE_NEEDS_REQUEST` backstop blocks a superuser delete; `nopm_mutate_audited` writes row + one audit row, refuses `STALE_ROW`, `UNKNOWN_COLUMN`, `TABLE_NOT_ALLOWED` (incl. a quoted-name injection), `FORBIDDEN_COLUMN` (workspace_id), accepts channel `github`; every audit row hashed, `nopm_audit_verify_chain` ok over 14 rows, tampering refused by the append-only trigger; `nopm_implement_change_request`, `nopm_commit_project_deletion`, `nopm_mutate_audited`, `nopm_auto_approve_routine` each have one overload; `work_events` and `approval_events` RLS on, browser roles SELECT-only |
| Final (after the fix pass) | 0100–0105 dry run 92 ms, atomic 82 ms; `probe-migrations` 9/9, `probe-four-eyes` 29/29 (new P2a: a manager is refused on an admin-tier project deletion); gates: tsc 0, vitest all but the CRLF case, lint 0 errors, cli 68, rtm:verify OK (144 R-IDs) |

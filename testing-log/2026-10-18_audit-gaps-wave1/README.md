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

## Observations for the next review

- Unlocking by direct SQL (`is_locked = false`) clears `locked_by_actor_id` through the 0088 trigger but leaves `locked_at` set. The unlock RPC clears everything; the trigger should too (P2).
- Node 24 on Windows prints `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` at exit of the seed scripts after their work completes. Harmless here; not a product bug.
- With a project locked, `seed-mainline-deps.mjs` is refused by the lock backstop (`PROJECT_LOCKED`) at its first step. Correct product behaviour; the seed is for fresh installs.
- Release order stands: 0088–0091 before the build serves traffic; 0091 is a hard dependency of the risk routes.

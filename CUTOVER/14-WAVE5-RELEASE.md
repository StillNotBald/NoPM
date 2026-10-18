# 14 · Wave 5 release (migrations 0107–0114, M1 close-out)

*Wave 5, W5-J (R-180). Follows the shape of [11-AUDIT-GAPS.md](11-AUDIT-GAPS.md). The checks after each step are in [12-POST-RELEASE-CHECKS.md](12-POST-RELEASE-CHECKS.md). The optional anchor is in [13-AUDIT-ANCHOR.md](13-AUDIT-ANCHOR.md).*

**Status: NOT YET RUN.** Merging the pull request is a separate decision for the owner, asked per pull request (standing merge rule). Nothing below runs before that yes.

## What ships

| Migration | When | Why that moment |
|---|---|---|
| 0106 (cycle 2, tier decisions) | phase 1, if PR #11 is not already live | Same rule as in 11: before the new build serves traffic. |
| 0107 to 0113 | **phase 1: before the new build serves traffic** | All additive and safe with the old build. They add the audit-insert helper, the atomic functions, the blocker and ETA columns, the anchor bookkeeping table, and the commit functions for programs, sprints, resources, allocations and clashes. |
| 0114 | **phase 2: after the new build is serving** | The database starts refusing a direct delete on those five tables. The old build still deletes them directly, so applying 0114 earlier breaks five delete routes until the new build is live (review finding PR-19). |
| `NOPM_ANCHOR_DB_URL` | last, optional | Without it everything works and every screen says "Not anchored". |

Ledger counts, assuming the live ledger is at 0105 (102 rows): phase 1 adds 8 files (0106 to 0113) and ends at 110 rows, last 0113. Phase 2 ends at 111 rows, last 0114. If PR #11 was released on its own first, the ledger starts at 103 and phase 1 adds 7 files; both end at 110 and 111.

No file drops a table or a column. No file changes or removes an existing row, except the 0106 data step, which closes old emergency requests, raises or lowers some pending deletion requests and rewrites stored GitHub rules, each with one audit row from "system (migration 0106)".

## Known consequences

- **Between phase 1 and the promote, the old build serves a database one wave ahead.** It works. The only straggler risk is an emergency change raised in the old shape (0106); the fix is in 11 and the check is 1.5 / 2.1 in 12.
- **Between the promote and phase 2, five delete routes still delete directly.** That is intended and short. Do not skip phase 2: until 0114 is applied, a script holding the service key can still delete programs, sprints, resources, allocations and clashes without an approved request.
- **After 0114, any direct delete on those five tables fails** with DELETE_NEEDS_REQUEST, including the seed scripts (the demo seed already stops with a clear message). A workspace purge must run in replica mode, as for 0102.
- **Five delete routes answer 202 instead of 204** (programs, sprints, resources, allocations, clashes): the request is created and an approver decides. Agents and scripts that expect 204 need to read the new body (owner decision D19).

## The runner has no "stop before 0114" option

`web/scripts/apply-migrations.mjs` applies every pending file in the folder. So phase 1 works on a clean clone from which the 0114 file has been moved aside, and phase 2 puts it back. The clone is a throwaway copy of main, so nothing in the repository changes, and the one-shot script restores the file on any exit. The rehearsal (below) does the same on a staged copy of the runner, so the mechanism is exercised before you rely on it.

## Before the window

1. **The local rehearsal is green.** From `web/`, with the local stack and the local app running (see `web/scripts/local-db/README.md`):

   ```sh
   node scripts/local-db/rehearse-wave5.mjs
   ```

   Expect every row PASS (26 of 26 when this was written) and no "GATE INCOMPLETE" line. It resets the local ledger rows of 0107 to 0114, runs phase 1 (dry run, then apply, with 0114 held back), runs the database probes in the state the old build sees, runs phase 2, runs the register probe again and the three app probes, then applies the whole range a second time and compares row counts and the audit chain. `--db-only` skips the three app probes and says so. It only ever touches the local stack: it refuses any non-loopback address.
2. **Group 0 of [12-POST-RELEASE-CHECKS.md](12-POST-RELEASE-CHECKS.md)** pasted into the SQL editor; the numbers written down.
3. **The pull request is merged** (the owner's yes, for that pull request) and you have the merge commit id for the script.
4. **`CRON_SECRET` is set** in the production environment (the nightly jobs authenticate with it).

## The window, in order

1. **Preflight (changes nothing).** `origin/main` is the expected commit, `web/.env.local` and `web/.vercel/project.json` exist in the working checkout, the Vercel login works.
2. **Clean clone of main**, `npm ci`, copy the two private files in. The copied `.env.local` is deleted at the end whatever happens.
3. **Back up the live database** (schema and data), saved as `pre-wave5-<yyyymmdd-hhmm>`. Private, never committed.
4. **Hold back 0114** in the clone: move the 0114 file to a folder next to the backups.
5. **Phase 1 dry run.** `node scripts/migrate.mjs --atomic --dry-run`. Expect `8 pending file(s) applied cleanly, then ROLLED BACK` (7 if PR #11 is already live). Read every NOTICE: the 0106 notices say which constraints stayed NOT VALID and how many rows the data step touched.
6. **Build without taking traffic.** `vercel deploy --prod --skip-domain`. Note the new URL and check its `/api/health`.
7. **Phase 1 apply.** `node scripts/migrate.mjs --atomic`. Expect `Committed 8 file(s) in one transaction` and a ledger of 110 rows, last 0113. The old build is still serving. On FAILED nothing was applied.
8. **Group 1 of [12](12-POST-RELEASE-CHECKS.md)** in the SQL editor (the script also checks the ledger and the absence of the five new triggers). Any miss: do not promote.
9. **Promote.** `vercel promote <new url>`, wait for `/api/health` on the live host, then `node scripts/auth-smoke.mjs`.
10. **Group 2 of [12]**, and the wave 5 smoke below.
11. **Phase 2.** Put the 0114 file back in the clone, `--atomic --dry-run` (expect `1 pending file(s)`), then `--atomic` (expect `Committed 1 file(s)`). Ledger 111 rows, last 0114.
12. **Group 3 of [12]**: ten enabled delete-refusing triggers, twelve commit functions that set the flag, a complete ledger, the chain still intact. Record the new head hash outside the database ([11-AUDIT-GAPS.md](11-AUDIT-GAPS.md) "Hash chain").
13. **Optional, last: the anchor.** Follow [13-AUDIT-ANCHOR.md](13-AUDIT-ANCHOR.md), set `NOPM_ANCHOR_DB_URL` on the host, redeploy, press "Verify now" once as an admin, then Group 4 of [12].
14. **Tag.** After the owner's yes (separate decision), tag the release as an annotated tag.

## Wave 5 smoke (after the promote, and again after phase 2)

Real audit rows are created by these; use a throwaway project.

1. Raise a change request, edit it, withdraw it. Each shows one audit row in the Trust Center (the change and its audit row are saved together now).
2. Request deletion of a task, then of a risk. A second person approves one and rejects the other. Withdraw a third.
3. **After phase 2 only:** request deletion of a program, a sprint, a resource member, an allocation and a clash. Each answers 202 and appears in Approvals with its own name. Approve one as a second person: it is removed. Approving a task that has an allocation, or a project that has a sprint, still works.
4. A task form shows the two new optional fields (blocker reason, ETA) and saves them.
5. Settings: switch two-step sign-in on and off for a test user. No server error. This was the live check from check 1.7.
6. Trust Center: the verify button answers `ok`, and the new card reads "Not anchored" until step 13.
7. At 390 px open Approvals and the Trust Center.

## Rollback, per phase

The shape is the one in [03-ROLLBACK.md](03-ROLLBACK.md): the app rolls back instantly, the database does not roll back. Migrations 0107 to 0113 are additive, so they never need undoing.

| Where you are | What to do | Database |
|---|---|---|
| Before the promote (steps 1 to 8) | Do not promote. The old build is still serving. The new build URL can be deleted. | Leave it. 0107 to 0113 are additive and the old build ignores them. |
| After the promote, before phase 2 | `vercel rollback`. When the fixed build is ready, `vercel promote` it explicitly (a rollback pins the alias: see [02-DEPLOY.md](02-DEPLOY.md)). | Leave it. The old build works on the wave 5 schema. |
| After phase 2 | `vercel rollback` **and** the one database step below. The old build deletes the five tables directly, and the triggers would refuse it. | Run the five lines below in the SQL editor. They only remove the triggers; no row changes. |
| After the anchor variable | Unset `NOPM_ANCHOR_DB_URL` and redeploy. Every screen goes back to "Not anchored". | Nothing to do. The bookkeeping table can stay. |
| Data corrupted by a migration (not expected: none of 0107 to 0114 rewrites rows beyond the 0106 data step) | Restore from the dump of step 3, following the version-skew rule in 03 and [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md). | Last resort. |

The only database rollback this release needs, from the header of 0114:

```
drop trigger if exists trg_programs_delete_needs_request on programs;
drop trigger if exists trg_sprints_delete_needs_request on sprints;
drop trigger if exists trg_resource_members_delete_needs_request on resource_members;
drop trigger if exists trg_allocations_delete_needs_request on allocations;
drop trigger if exists trg_clashes_delete_needs_request on clashes;
```

It is a write, so it is not in 12. The rehearsal runs exactly these lines at its step 2 and then re-applies 0114, so the rollback and the re-apply are both known to work.

**If 0114 was applied too early** (check 1.8 shows triggers on the five registers while the old build serves): either promote the new build now, or run the five lines above and apply 0114 again after the promote.

## The owner's one-shot script, as a diff against the 2026-10-18b script

The script is the same pattern as `_docs/nopm-release-2026-10-18b-audit-gaps.sh`: clean clone, dump, atomic dry run, deploy without the alias, atomic apply, ledger check, promote, smoke. Three things change: 0114 is held back for phase 1, a second migrate call follows the promote, and the expected counts.

```diff
-# NoPM release 2026-10-18b: the audit-gap programme (PR #9, main a0fd35a, migrations 0088-0105).
+# NoPM release wave 5: M1 close-out (PR <n>, main <merge sha>, migrations 0106-0114 in two phases).
-# Order (fixed): clean clone of main -> backup -> atomic DRY RUN -> build WITHOUT alias -> atomic APPLY -> verify ledger
-#                -> promote -> smoke. ...
+# Order (fixed): clean clone -> backup -> hold back 0114 -> phase 1 DRY RUN -> build WITHOUT alias -> phase 1 APPLY
+#                -> verify ledger (110) -> promote -> smoke -> put 0114 back -> phase 2 DRY RUN -> phase 2 APPLY
+#                -> verify ledger (111) and ten triggers -> smoke. 0114 lands AFTER the new build serves (PR-19).
-# Rollback: app = Vercel instant rollback (...); DB = restore the dump written in step 2 (CUTOVER/03, 04). Migrations are forward-only.
+# Rollback: app = Vercel instant rollback; after phase 2 also run the five `drop trigger` lines (CUTOVER/14).
+#           DB restore of the dump stays the last resort (CUTOVER/03, 04). Migrations are forward-only.
-EXPECT_SHA="a0fd35a"
+EXPECT_SHA="<merge sha>"
+PHASE1_FILES="${PHASE1_FILES:-8}"            # 8 when 0106 is in this release, 7 if PR #11 is already live
+HELD="$BACKUPS/held-0114"
+F0114=""
-trap 'rm -f "$DIR/web/.env.local"' EXIT
+# one trap for both: the copied secrets file goes, and the held-back migration goes back where it came from
+trap 'rm -f "$DIR/web/.env.local"; [ -n "$F0114" ] && [ -f "$HELD/$F0114" ] && mv "$HELD/$F0114" "$DIR/web/supabase/migrations/"' EXIT
@@ step 1 (clone) — after the HEAD_SHA check
-ls "$DIR/web/supabase/migrations" | tail -18 | head -1 | grep -q 20261018000088 || die "..."
+ls "$DIR/web/supabase/migrations" | grep -q '^20261018000114_' || die "0114 is not in the clone"
@@ step 2 (backup) — file names
-pre-0088-$TS-schema.sql / pre-0088-$TS-data.sql
+pre-wave5-$TS-schema.sql / pre-wave5-$TS-data.sql
+log "2b. hold back 0114 (phase 2 puts it back after the promote)"
+mkdir -p "$HELD"
+F0114=$(ls "$DIR/web/supabase/migrations" | grep '^20261018000114_')
+mv "$DIR/web/supabase/migrations/$F0114" "$HELD/$F0114"
+[ "$(ls "$DIR/web/supabase/migrations" | grep -c '^20261018000114_')" = 0 ] || die "0114 is still in the migrations folder"
@@ step 3 (dry run) — phase 1
-log "3. atomic DRY RUN of 0088-0105 ..."
-grep -q "18 pending file(s) applied cleanly, then ROLLED BACK" "$LOG" || die "..."
+log "3. phase 1 atomic DRY RUN of 0106-0113 (rolls back; read every NOTICE)"
+grep -q "$PHASE1_FILES pending file(s) applied cleanly, then ROLLED BACK" "$LOG" || die "phase 1 dry run did not report $PHASE1_FILES pending files rolled back cleanly"
@@ step 4 (build) — unchanged: vercel deploy --prod --skip-domain
@@ step 5 (apply) — phase 1
-log "5. APPLY 0088-0105 in one transaction"
-grep -q "Committed 18 file(s) in one transaction" "$LOG" || die "..."
-... r.n!==102 || last startsWith "20261018000105" ...
+log "5. phase 1 APPLY 0106-0113 in one transaction"
+grep -q "Committed $PHASE1_FILES file(s) in one transaction" "$LOG" || die "phase 1 apply did not commit $PHASE1_FILES files"
+... r.n!==110 || last startsWith "20261018000113" ...       # ledger check: 110 rows, last 0113
+# plus, in the same node check: select count(*) of the five new triggers must be 0 (0114 is not in yet)
@@ step 6 (promote) — unchanged, then the health wait
+log "6b. phase 2: put 0114 back and apply it, now that the new build serves"
+mv "$HELD/$F0114" "$DIR/web/supabase/migrations/$F0114"
+(cd "$DIR/web" && node scripts/migrate.mjs --atomic --dry-run 2>&1 | grep -v "already exists\|does not exist, skipping\|^skip ") | tee -a "$LOG"
+grep -q "1 pending file(s) applied cleanly, then ROLLED BACK" "$LOG" || die "phase 2 dry run did not report exactly 0114 pending"
+(cd "$DIR/web" && node scripts/migrate.mjs --atomic 2>&1 | grep -v "already exists\|does not exist, skipping\|^skip ") | tee -a "$LOG"
+grep -q "Committed 1 file(s) in one transaction" "$LOG" || die "phase 2 apply did not commit 0114"
+... ledger check: r.n!==111 || last startsWith "20261018000114" ...
+... trigger check: count of pg_trigger rows named trg_%_delete_needs_request must be 10 and all enabled
@@ step 7 (smoke) — unchanged: node scripts/auth-smoke.mjs
@@ DONE message
-log "DONE. Next: as admin ... Approval policy ... Integrations -> GitHub ... Trust Center -> Verify chain ..."
+log "DONE. Next: paste CUTOVER/12 groups 1 to 3 into the SQL editor and write down the chain head hash."
+echo "      Optional, last: the anchor (CUTOVER/13), then CUTOVER/12 group 4."
+echo "      Backups: $BACKUPS/pre-wave5-$TS-{schema,data}.sql"
@@ --check preview text
-echo "WOULD: ... migrate --atomic --dry-run (expect 18 pending files ...) ... migrate --atomic (apply 0088-0105) ..."
+echo "WOULD: ... hold back 0114, phase 1 dry run (expect $PHASE1_FILES pending), deploy --skip-domain, phase 1 apply (ledger 110),"
+echo "       promote, put 0114 back, phase 2 dry run (expect 1 pending), phase 2 apply (ledger 111, ten triggers), smoke."
```

Why the script puts 0114 back **after** the promote and the health check, and not before: the promote is the moment the new build serves. Putting the file back earlier would not change the database, but moving it back after the promote keeps the script's order identical to the runbook.

If the script stops between steps 6 and 6b, the database is at phase 1 with the new build serving. That is a safe resting place. Re-run only the phase 2 lines (step 11 of the runbook), or put the file back by hand and run `node scripts/migrate.mjs --atomic` once.

## Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (rehearsal green, phase 1 and phase 2 executed, checks 12 filed) | | | |

## Run record

_Not yet run._ Record: backup taken, phase 1 dry-run output, phase 1 apply output and time, ledger (110), promote time, smoke, phase 2 output, ledger (111), the ten triggers, the chain head hash, and the anchor state.

# 07 · Lark wave rollout (migrations 0045–0054)

**Status: ACTIVE** — rehearsed end to end on a scratch database built to the live ledger state; executed against the live project on 2026-10-17 (see "Run record — 2026-10-17" at the end).

Release-specific runbook for the build that adds principal-aware four-eyes, the integration hub (Lark approval cards, weekly digest), calendar feeds, lifecycle guards and the delivery fixes, plus the project-deletion scope follow-up and privilege tightening of 0054. It extends [02-DEPLOY.md](02-DEPLOY.md) (which says "migrations first, then deploy") for the one release where that is not enough: **migration 0045 removes the deletion-commit functions the previous build calls**, so the order and the window shape matter. Read [03-ROLLBACK.md](03-ROLLBACK.md) first and keep it open.

**State before the run (it was applied 2026-10-17, see the run record below; the live ledger now holds 0001–0054).** The live ledger held 0001–0044 plus **0048** (the direct-write lockdown, applied out of order as a hotfix on 2026-10-17, file `20261016000048_rls_api_only_writes.sql`). Pending: 0045, 0046, 0047, 0049, 0050, 0051, 0052, 0053, 0054 (nine files). The runner skips applied names, so 0048 is skipped and the rest apply in filename order.

**Order, fixed:** backup → pre-check → environment variables → build without aliasing → apply all nine files in ONE transaction → post-check → promote → post-deploy. Never deploy the new build before the migrations: on the old schema it fails every governed decision, the Tokens list, the AI assistant, timesheet submit/reopen and the whole hub. The only break in the right order is the previous build's task/project deletion approvals between the migration commit and the promote (seconds).

SQL used below lives in `CUTOVER/sql/lark-wave/` (each file starts with a header saying what it does, whether it writes, and when to run it).

## 1. Before you start

- [ ] Tell the team: no deletion approvals during the window.
- [ ] Supabase dashboard → Settings → Database → Backups: note whether PITR exists on this tier and the current time (UTC).
- [ ] You are on the commit you will deploy, clean tree (`git status` empty). `ls web/supabase/migrations | tail -10` shows 0045 … 0054.
- [ ] The live direct connection string (port 5432) is in `web/.env.local` (the runner derives it) or exported as `DB_URL`. Never print it.
- [ ] Read-only sanity: `select version(); select current_user, current_setting('is_superuser');` (the hosted `postgres` role is not a superuser; that is expected).

## 2. Backup and pre-check

Backup, per [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md), before anything else:

```bash
cd web
supabase db dump --db-url "$DB_URL" -f ../backup-pre-0045-<yyyymmdd-hhmm>.sql    # private; never commit it
```

Restore rules (from [03-ROLLBACK.md](03-ROLLBACK.md)): never restore to a point earlier than the 0048 hotfix without re-applying 0048 at once, and never past the migration head of a build that is still serving.

Run `CUTOVER/sql/lark-wave/precheck.sql` (read-only) as `postgres` in the SQL editor and paste the whole result into the cutover ticket. Gates:

| Row | Required | If not |
|---|---|---|
| A1 ledger rows | 45 | stop: the ledger is not what this runbook assumes |
| A3 pending files already in the ledger | none | stop |
| B1, B2 wave objects already present | none | stop: a half-applied earlier attempt |
| C1 `audit_channel_check` | 1 | stop: 0046 drops it by name and would fail |
| C2 / C3 triggers / helper functions | 3 / 3 | stop |
| C4 deletion-commit functions | two, seven arguments each | stop |
| C5 API roles | 3 | stop |
| D4 long-running transactions | none | wait or end them: the DDL would queue behind them |
| D1 `audit_log` rows | under about 5 M | above that, ask first: 0046 scans it under an exclusive lock (about 0.5 s per million rows) |
| E4 duplicate sign-offs | 0 | 0045 aborts by design (F-04): review and run `CUTOVER/sql/lark-wave/dedupe-signoffs.sql`, then repeat the pre-check |
| E5 pending deletion requests | note it | decide or withdraw them first, or approve none until the promote |
| E7 / E8 submitted timesheets / drifted ones | note it | after 0049 submitted weeks freeze (E7) and drifted sheets cannot be approved (E8): reject stale or drifted sheets first (F-05) |
| E1 tokens with no creator | note it | they can never approve after 0045; re-mint under a named person if one is used for approvals |
| F1–F4 | note them | F1–F3 are the "decided by the same human" history 0045 keeps; the runner prints the same three numbers in a notice; F4 requests stay approvable by any human, settle them |

## 3. Environment variables (Vercel, Production)

Set before the build; environment changes need a new build.

| Name | Need | Value / note |
|---|---|---|
| `CRON_SECRET` | **required, new** | `openssl rand -base64 32`, at least 32 characters, no spaces; `vercel env add CRON_SECRET production`. Unset: `/api/integrations/cron` refuses every call, the weekly digest never sends, nothing is pruned (cards still send). Vercel attaches it to its own cron call; `web/vercel.json` declares the cron (`/api/integrations/cron`, `7 1 * * *`), registered when the deployment is promoted. |
| `NOPM_ENCRYPTION_KEY` | **required, verify present** | 32-byte base64; the previous build already needs it for MFA. Connector secrets are AES-256-GCM under the same key; if it is missing, creating a connector returns 503. Never change it. |
| `NEXT_PUBLIC_APP_URL` | recommended | `https://stillnotbald.com`. It wins over `VERCEL_PROJECT_PRODUCTION_URL` for calendar-feed URLs and card deep links. Must not be a localhost value. |
| `NOPM_RATE_CAL_PER_MIN`, `NOPM_RATE_CAL_IP_PER_MIN` | optional | calendar feed limits per feed / per client address per minute (defaults 60 / 120) |
| `NOPM_RATE_LARK_PER_MIN` | optional | authenticated Lark webhook calls per connector per minute (default 300) |
| `NOPM_TRUSTED_PROXY_HOPS` | **leave unset on Vercel** | self-host only: number of reverse proxies in front of the app |
| `NOPM_LARK_API_BASE_OVERRIDE`, `NOPM_ALLOW_LARK_OVERRIDE` | **must be unset** | test-only switches that redirect the Lark client |
| unchanged, verify present | | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NOPM_TOKEN_PREFIX`, `DEMO_EMAIL`, `DEMO_PASSWORD`, `NOPM_DEMO_LLM_*`, `NOPM_RATE_READ_PER_MIN`, `NOPM_RATE_WRITE_PER_MIN` |

Lark app credentials (app id, secret, verification token, encrypt key) are not environment variables: they are entered per connector in the console and stored encrypted. `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_REGION`, `NOPM_APP_URL`, `NOPM_LARK_CONNECTOR_ID` and `NOPM_LARK_RELAY_SECRET` belong only to `web/scripts/lark-worker.mjs`, a separate long-connection process that a public URL does not need. Every variable is documented in `web/.env.example`.

## 4. The window

Runner flags (documented in the header of `web/scripts/apply-migrations.mjs`; `migrate.mjs` passes them through): `--atomic` applies every pending file in one transaction with `lock_timeout` 15 s; `--dry-run` runs everything and rolls back; notices raised by migrations are printed in every mode; after a commit the runner sends `notify pgrst, 'reload schema'`.

1. **Build, do not alias:** `cd web && vercel deploy --prod --skip-domain`. Note the deployment URL (`<NEW_URL>`); `curl <NEW_URL>/api/health` answers ok. Do not exercise governed screens on it yet, it is on the old schema.
2. **Dry run:** `node scripts/migrate.mjs --atomic --dry-run`. Expect nine files applied, then `Dry run complete ... ROLLED BACK. Nothing changed.`, and a 0045 notice whose three numbers equal pre-check F1–F3. File the output as a dry-run record ([06-DRY-RUN-RECORDS.md](06-DRY-RUN-RECORDS.md)).
3. **Apply:** `node scripts/migrate.mjs --atomic`. Expect `Committed 9 file(s) in one transaction` and `PostgREST schema cache reload requested`. On `FAILED` nothing was applied and the ledger is unchanged: read the message, fix the cause (pre-check C rows, E4), re-run.
   Without `--atomic` the runner commits per file; if it stops at 0046, fix and re-run at once, because until 0046 is in the deletion-commit functions are broken for both builds (F-02).
4. **Post-check:** run `CUTOVER/sql/lark-wave/postcheck.sql` (read-only). Every row reads `ok` (row 24 reads `info`). Any `CHECK`: do not promote, go to section 7.
5. **Optional bridge**, only if step 6 may be delayed: `CUTOVER/sql/lark-wave/bridge-up.sql` gives the previous build a working deletion approval until the promote. It restores exactly today's behaviour (actor-id check only).
6. **Promote:** `vercel promote <NEW_URL>`; `vercel ls` confirms the production alias moved. If you used the bridge, run `CUTOVER/sql/lark-wave/bridge-down.sql` now.

The window is the time between the commit of step 3 and the promote of step 6. During it, on the previous build only: deletion approvals return 500, reopening a timesheet leaves the week frozen, and a rebaseline sign-off on an applied, approved or draft rebaseline returns 500.

## 5. After the promote

1. Run `CUTOVER/sql/lark-wave/post-window-backfill.sql` (fills principals on rows the previous build wrote inside the window; idempotent), then the migration-0052 backfill once more:
   ```sql
   update api_tokens set kind = 'assistant'
    where kind = 'user' and name like 'AI Assistant ' || chr(183) || '%'
      and expires_at is not null and expires_at <= created_at + interval '61 minutes';
   ```
2. Run `postcheck.sql` again; rows 21 and 22 read 0.
3. `curl https://stillnotbald.com/api/health`, then `cd web && node scripts/auth-smoke.mjs` (same pass count as the 0048 smoke).
4. Cron: the Vercel dashboard (project → Settings → Cron Jobs) lists `/api/integrations/cron  7 1 * * *`. Call it once: `curl -sS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $CRON_SECRET" https://stillnotbald.com/api/integrations/cron` expects 200; without the header 401.
5. Optional governed smoke (creates real audit rows, use a throwaway task): person A raises a task deletion, person B approves it; person A approving with a token they minted gets 403 self-approval; create a calendar feed and fetch its URL; the Tokens list hides only assistant tokens.
6. Connecting Lark is a separate step in the console and is not part of this window.

## 6. Per-migration rollback notes

Migrations are forward-only ([03-ROLLBACK.md](03-ROLLBACK.md)); this is what is safe to undo.

| File | If you must undo | Status |
|---|---|---|
| 0045 | Keep the columns and CHECKs (additive; the CHECKs only bite legacy same-human rows). To let the previous build approve deletions again run `CUTOVER/sql/lark-wave/bridge-up.sql`. Do not remove the twelve-argument functions while the new build serves. | bridge tested |
| 0046 | Leave in place; the previous build ignores the new tables and columns. Do not narrow `audit_channel_check` back once an audit row with channel `lark` exists (it would not validate). | not run |
| 0047 | Leave. Dropping `calendar_feeds` only kills the feed URLs. | not run |
| 0048 | Already live. Rollback text is in the file header; never restore the `profiles` self-update policy. | n/a |
| 0049 | `CUTOVER/sql/lark-wave/rollback-0049.sql` (removes the five triggers, restores the 0040 week-lock body, keeps the columns). Weakens governance; re-apply the trigger statements when the new build returns. | tested |
| 0050 | Leave. Removing `trg_audit_no_truncate` weakens immutability. `nopm_rate_check` keeps its signature; its earlier body is in 0029. | not run |
| 0051, 0052, 0053 | Leave (indexes, one bookkeeping table, a defaulted column, two nullable columns; the previous build ignores them). | not run |
| 0054 | Leave. It redefines `nopm_project_child_counts()` (15 keys instead of 12), refreshes the snapshot of pending project deletions, and revokes write / `MAINTAIN` privileges from the API roles and `EXECUTE` of `nopm_recompute_project_completion()`; the previous build uses none of those paths. Re-granting those privileges is not recommended. | not run |

App rollback is `vercel rollback` (a rollback pins the alias until `vercel promote`, see [02-DEPLOY.md](02-DEPLOY.md)). **After 0045, rolling the app back also needs `bridge-up.sql`**, and `rollback-0049.sql` if the previous build's reopen and sign-off behaviour matters. The matching row of the decision table in [03-ROLLBACK.md](03-ROLLBACK.md) ("migration applied cleanly, new code broken") carries this exception. Database restore (dump or PITR) is the last resort and loses every write since the snapshot.

## 7. If a check fails

| Symptom | Action |
|---|---|
| Runner `FAILED` | With `--atomic` nothing was applied. Fix the cause, re-run. |
| Post-check row 16 reads 0 | The sign-off unique index is missing. Run `dedupe-signoffs.sql` if duplicates exist, then create `uniq_rebaseline_signoff_approver` as written in 0045. |
| Post-check rows 3–8, 11, 12 fail | A new table or function, or any public table, is reachable with write / `MAINTAIN` privileges by an API role, or a new function is not reachable by `service_role`. Do not promote; stop and escalate. |
| Post-check rows 21 / 22 non-zero after the window | Re-run `post-window-backfill.sql`. |
| New build misbehaves after the promote | `vercel rollback`, then `bridge-up.sql`; investigate with the new build off. |
| PostgREST says a column is not in the schema cache | `notify pgrst, 'reload schema';`, retry in a few seconds. |

## 8. Rehearsal findings

The migrations 0045–0047 and 0049–0054 were applied, in live order, to a scratch database holding the live ledger state (0001–0044 plus 0048) and seeded with hostile legacy rows (same-human decisions, a token without creator, a drifted timesheet, a duplicate sign-off, 300 k audit rows). The resulting catalog (policies, grants, functions, constraints, triggers, RLS flags, indexes, columns) is identical to the same migrations applied in pure filename order: the out-of-order 0048 does not leave live more permissive. All nine files apply in well under a second at that volume.

| # | Severity | Finding | Fix / mitigation |
|---|---|---|---|
| F-01 | High | 0045 removes the seven-argument deletion-commit functions (`0045:235-236`, `:334-335`); the previous build calls them (`web/src/app/api/deletion-requests/[id]/approve/route.ts`), so task and project deletion approvals return 500 from the migration commit until the promote. Certain, and deliberate (a surviving old function would skip the principal check). | Build with `--skip-domain`, apply, promote: the break lasts seconds. Optional `bridge-up.sql` / `bridge-down.sql`. |
| F-02 | Medium | The runner committed per file. A stop between 0045 and 0046 left deletion approvals broken for both builds (0045's functions write `audit_log` columns that only 0046 adds). | `--atomic`: one transaction, so the database is at the old head or the new head. |
| F-03 | Medium | The runner printed no NOTICE / WARNING, hiding 0045's "decided by the same human" counts. | Notices are printed in every mode. |
| F-04 | Medium | With duplicate `(rebaseline_id, approver_id)` sign-offs 0045 skipped its unique index with a warning, the runner said ok, and every sign-off then failed 42P10. | 0045 now raises an exception that points at `dedupe-signoffs.sql`; pre-check E4 catches it first; post-check row 16 asserts the index. |
| F-05 | Medium | 0049 acts on in-flight rows at commit: submitted weeks freeze, drifted sheets become unapprovable (P0013), pending project deletions are re-snapshotted. | Operational: pre-check E5–E8; settle or reject before the window. |
| F-06 | Low | The NOT VALID principal CHECKs (0045) still reject any UPDATE of a legacy same-human row (23514). New-build routes never update such rows; the previous build's timesheet reopen would. | **Known limitation, accepted for this release** (no change made to 0045). A grandfather clause on `decided_at` would lift it; not part of this release. |
| F-07 | Low | Rows the previous build writes inside the window carry NULL principals and `kind = 'user'`. | `post-window-backfill.sql` and the 0052 backfill, run after the promote (section 5). |
| F-08 | Low | The runner set no `lock_timeout`; 0046 scans `audit_log` under an exclusive lock (136 ms at 300 k rows, linear); other DDL holds exclusive locks for milliseconds. | `--atomic` sets `lock_timeout` 15 s; pre-check D1 and D4. |
| F-09 | Low | `anon` and `authenticated` held INSERT/UPDATE/DELETE on nine RLS-deny-all tables (including `audit_log` and `api_tokens`), and on PostgreSQL 17 the `MAINTAIN` privilege (allows `LOCK TABLE`) on every table. Nothing was writable because RLS has no write policy; this was the missing second layer. | **Fixed by migration 0054** (write grants on the nine tables and `MAINTAIN` revoked, default privileges adjusted, `nopm_recompute_project_completion()` closed to the API roles); post-check row 8 asserts it. |
| F-10 | Low | Docs that disagreed with the release: the `docs/ops/PROD_DOOR.md` migration-head row (still 0032), the "roll the app back, the schema addition is harmless" row of [03-ROLLBACK.md](03-ROLLBACK.md), and the "backward-compatible one migration behind" rule of [02-DEPLOY.md](02-DEPLOY.md). | Fixed with this runbook: each now states the exception for this release and links here. |
| F-11 | Info | Fail-closed behaviour to expect: a token without a recorded creator can never approve (`NO_PRINCIPAL`); a request whose requester principal is unknowable stays approvable by any human; same-human history is kept, not blocked. | Pre-check E1, F1–F4 count them. |

Previous build against the migrated schema: deletion approval 500 (F-01); timesheet reopen leaves the week frozen (the previous build never sets `reopened_at`); rebaseline sign-off recompute raises P0014 on applied, approved or draft rebaselines and returns 500; a locked project's date PATCH is refused by the database and surfaces as 500; time-entry edits in a submitted week surface P0012 as 500. Everything else read in the previous build keeps working (rate limiter signature unchanged, tokens list, audit writes, deletion reject, change-request and timesheet decisions).

New build against the unmigrated schema: deletion approval, sign-off, change-request and timesheet decisions, timesheet submit and reopen, the Tokens list, the AI assistant, the change-control page and the whole hub and calendar-feed surface fail (missing function, columns or tables). First-party audit writes still work because the connector columns are only written for connector actors.

## 9. Do not

- Apply a migration file by hand without writing its ledger row: the runner will apply it again and fail.
- Run two runners at once.
- Deploy before the post-check passes, or set the two test-only Lark override variables.
- Restore a backup older than the 0048 hotfix without re-applying 0048.

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (rollout executed, post-check filed) | | | |
| Client witness (optional) | | | |

---

## Run record — 2026-10-17

Times are UTC. Code: PRs #7 and #9 merged; main is `ba1044c`.

| Step | Result |
|---|---|
| Backup (section 2) | A schema dump and a data dump were taken before the apply and are stored outside the repo. |
| Pre-check (section 2) | Read-only `precheck.sql` passed every hard gate. The F1–F4 history counts were 6, 1, 0 and 0 (F1 deletion requests, F2 change requests, F3 timesheets, F4 unknowable requester). |
| Environment (section 3) | `CRON_SECRET` added to Vercel production. |
| Dry run (section 4, step 2) | `--atomic --dry-run`: "Dry run complete in 623 ms: 9 pending file(s) applied cleanly, then ROLLED BACK. Nothing changed." |
| Apply (section 4, step 3) | `apply-migrations.mjs --atomic`: 0045–0047 and 0049–0054 committed in one transaction at 06:04:26–06:04:27 UTC: "Committed 9 file(s) in one transaction (495 ms)." |
| Promote (section 4, step 6) | New build promoted at 06:04:50 UTC. The previous build ran against the new schema for about 25 s. |
| Post-check (section 4, step 4) | `postcheck.sql`: 26 rows, 25 `ok`, row 24 `info` (api_tokens by kind). No row failed. |
| Backfill (section 5.1) | `post-window-backfill.sql` run; rows 21 and 22 read 0. |
| Smoke (section 5.3) | Authenticated smoke test: 24 of 24. |
| Cron (section 5.4) | `/api/integrations/cron` returns 401 without the secret and 200 with it. |

The 0045 notice reported 6 deletion requests and 1 change request decided by the same human who raised them (kept as history; blocked from now on).

Not in this record: the migration-0052 backfill statement (section 5.1) and the governed smoke test (section 5.5).

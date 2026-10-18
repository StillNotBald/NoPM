# Disaster-recovery runbook — PITR restore drill

**Status: DRAFT — procedure specified, not yet executed.** No scripts ship with this document; the runbook itself is the deliverable, per the owner's 2026-08-15 decision to make Wave-3 infra documentation-only (see [`docs/adr/0010-f3-deferral-and-infra-as-documentation.md`](adr/0010-f3-deferral-and-infra-as-documentation.md)).

## How this relates to the existing backup/restore runbook

[`docs/runbooks/backup-restore-drill.md`](runbooks/backup-restore-drill.md) is the **canonical owner** of the general `supabase db dump` / `psql` restore procedure and its evidence log — that file does not change here. This runbook is narrower and complementary: it drills the **Supabase dashboard PITR (Point-In-Time Recovery)** path specifically (restore-to-a-timestamp against a running managed project, not a `.sql` dump file), and adds a governance-specific verification step (audit-log immutability) that the dump/restore drill doesn't cover. Run whichever drill matches the recovery mechanism you actually intend to rely on; running both is stronger evidence than either alone.

## Backup posture (today)

- **Mechanism:** Supabase-managed backups. Two flavors, both described in [`CUTOVER/04-BACKUP-RESTORE.md`](../CUTOVER/04-BACKUP-RESTORE.md): explicit `supabase db dump` (on-demand, logical) and Supabase dashboard **PITR** (continuous, restore-to-any-second within the retention window).
- **Tier gap:** PITR is a **paid-tier** feature. NoPM's live project (`nopm`, ap-southeast-1) — check its current tier before assuming a PITR window exists; free-tier Supabase projects get daily backups only, not PITR, and this runbook's drill (below) requires PITR to actually be available on the project it's run against. If the live project is on the free tier, only the dump/restore drill (`docs/runbooks/backup-restore-drill.md`) is exercisable.
- **Free-tier inactivity pause (a live gotcha, not a hypothetical):** the free tier also silently pauses a project after inactivity, which has previously taken down the whole live demo without warning (see memory: `supabase-pause-demo-outage`). The weekly smoke run doubles as a keep-alive ping for exactly this reason. This is a *different* failure mode from "we need to restore data" — it's "the project itself went to sleep" — but it belongs in a DR posture doc because the operator response (wake the project, don't panic-restore) is worth stating explicitly: a paused project is not data loss and does not need this drill.
- **Retention:** governed by whatever the Supabase project's plan provides — not independently configured or verified by any script in this repo. Confirm current retention window on the dashboard (Settings → Database → Backups) before treating any specific past timestamp as recoverable.

## PITR restore drill — procedure

This is an **executable-when-needed** drill: run it before it's needed (to prove the path works) and again after any real incident that used it (to re-confirm), filing evidence both times per the log at the bottom of this file.

### Prerequisites

- A **scratch** Supabase project, separate from the live `nopm` project — never restore into something you can't afford to overwrite mid-drill.
- Dashboard access to both the source project (to trigger PITR) and the scratch project (to verify against).
- `web/.env.local` (or a second env file swapped in via `BASE=`) pointed at the scratch project once repointed.

### Steps

1. **Restore prod → sandbox project.** From the Supabase dashboard on the *scratch* project: Settings → Database → Backups → PITR → pick a timestamp → Restore. (If drilling against a genuine incident timestamp, pick that moment; if drilling proactively, any recent timestamp inside the retention window is sufficient to prove the mechanism.) Confirm the [version-skew ordering rule](../CUTOVER/03-ROLLBACK.md#-version-skew-ordering-rule-boxed-warning) — do not restore to a point before the oldest currently-deployed build's migration head.
2. **Repoint `.env.local`.** Update `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, `DB_URL` to the scratch project's values (see [`docs/SELF_HOSTING.md`](SELF_HOSTING.md) env matrix for what each variable means, if that's unfamiliar).
3. **Run `auth-smoke` as verification.**
   ```bash
   cd web
   BASE=<scratch-project-app-url> node scripts/auth-smoke.mjs
   ```
   A clean restore prints the same page-count result `auth-smoke` reports against a healthy live target (see [`CUTOVER/01-INSTALL.md`](../CUTOVER/01-INSTALL.md) step 8 / [`CUTOVER/05-GO-NO-GO.md`](../CUTOVER/05-GO-NO-GO.md) gate HG-3) — a clean `19/19` (or whatever the current page count is) is the pass signal, not just "the restore finished".
4. **Verify audit-log immutability survived the restore.** The append-only guarantee is enforced by two DB triggers (`trg_audit_no_update`, `trg_audit_no_delete`, function `nopm_audit_immutable()`, migration `web/supabase/migrations/20260608000006_governance.sql`) — a restore that silently dropped or didn't recreate these would be a governance-breaking regression, not just a data-recovery one. Against the restored scratch project, attempt:
   ```sql
   update audit_log set action = 'tampered' where id = (select id from audit_log limit 1);
   ```
   **Expected result: the statement fails** (`audit_log is append-only: UPDATE is not permitted`). If it succeeds, the restore is not safe to promote — the trigger did not survive and this is a blocking finding, not a note.
5. **Measure elapsed time = RTO.** Record wall-clock time from the start of step 1 (clicking Restore) to the finish of step 3 (a clean `auth-smoke` pass). This is the drill's Recovery Time Objective evidence — how long a real PITR restore actually takes end-to-end, not an estimate.
6. **Record a dated drill log entry** in the table below. A drill without a logged entry is not evidence it happened.

### What this drill does NOT cover

- Self-hosted PITR — there is no self-hosted backup mechanism at all yet (see [`docs/SELF_HOSTING.md`](SELF_HOSTING.md) §4 and [`CUTOVER/04-BACKUP-RESTORE.md`](../CUTOVER/04-BACKUP-RESTORE.md) "Self-hosted path — STUB").
- The `supabase db dump` / `psql` file-based restore path — that's [`docs/runbooks/backup-restore-drill.md`](runbooks/backup-restore-drill.md).
- RLS/Auth-claim parity after restore — `auth-smoke` exercises real authenticated page renders as an admin session, which is a strong proxy for RLS working, but is not an exhaustive per-policy check.

## Drill log

One row per execution — proactive or post-incident. A dated evidence folder under `testing-log/` (following the convention in `testing-log/README.md`) is stronger evidence than this row alone; link it in the last column when one exists.

| Date | Operator | Restore point (PITR timestamp) | Scratch project | auth-smoke result | Audit-immutability check (UPDATE attempt) | RTO (elapsed) | Evidence folder |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (drill procedure current + last run reviewed) | | | |
| Client witness (optional) | | | |

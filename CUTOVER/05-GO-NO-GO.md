# 05 · Go / No-Go

**Status: ACTIVE**

Six hard gates. Each row's **current state** is a link to the file/mechanism that owns that fact — this sheet never restates a pass/fail number itself. When a gate's state changes, update the owning file/run first; this sheet is re-read, not re-written, to reflect it (**closing rule**, see bottom).

| # | Gate | Current state (link) | Decision | Pre-approved fallback | Signature |
|---|---|---|---|---|---|
| HG-1 | Migrations applied to target DB, `_nopm_migrations` ledger matches `web/supabase/migrations/` | Mechanism: [`web/scripts/apply-migrations.mjs`](../web/scripts/apply-migrations.mjs) via [02-DEPLOY.md](02-DEPLOY.md) §1. Verify by querying `select name from _nopm_migrations order by applied_at;` against the target `DB_URL` and diffing against the migrations directory listing. | GO / WAIVE / NO-GO | Re-run `node scripts/migrate.mjs` (idempotent — skips applied files) and re-verify. | |
| HG-2 | Full test suite green | Mechanism: `.github/workflows/ci.yml` job `verify` (`npm test`, working dir `web`) — check the Actions run for the commit being cut over. Local: `cd web && npm run test`. | GO / WAIVE / NO-GO | Fix the failing test or waive with a committed date (see Waivers). | |
| HG-3 | Authenticated rehearsal 19/19 live | Mechanism: [`web/scripts/auth-smoke.mjs`](../web/scripts/auth-smoke.mjs); recorded runs: `.github/workflows/e2e-smoke.yml` (weekly + on-demand). Run on-demand for cutover: `node scripts/auth-smoke.mjs` against the target `BASE`. | GO / WAIVE / NO-GO | Re-run after fixing the failing page; a red auth-smoke has historically caught real bugs the unit suite missed (see memory: live-authenticated-rehearsal) — treat a failure here as high-signal, not flaky. | |
| HG-4 | E2E Tier 1 (read-only) green | Mechanism: `web/playwright.config.ts` + `web/e2e/*.spec.ts` (all specs except `writes.spec.ts`, which is Tier 2 / opt-in). Run: `cd web && npx playwright test` (Tier 2 skips itself unless `E2E_WRITES=1`). | GO / WAIVE / NO-GO | Re-run against the target `BASE` after fixing the failing spec. | |
| HG-5 | Security scan / dependency audit clean | Mechanism: `.github/workflows/ci.yml` jobs `dependency-audit` (`npm audit --omit=dev --audit-level=critical`) and `secrets-scan` (gitleaks, full history); standing exceptions documented in [`SECURITY.md`](../SECURITY.md) "Standing known items". | GO / WAIVE / NO-GO | Waive only against a documented standing exception (`SECURITY.md`); a new critical finding is NO-GO until patched or exception-documented. | |
| HG-6 | Backup taken & restore point named | Mechanism: [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md) — `supabase db dump` or a Supabase dashboard PITR timestamp taken **before** this cutover's migrations. Evidence: a dated folder under `testing-log/` naming the dump file/timestamp. | GO / WAIVE / NO-GO | No fallback — this gate has no safe waive on a migration that touches existing data (see [03-ROLLBACK.md](03-ROLLBACK.md) version-skew rule). Waivable only when the cutover has zero destructive migrations. | |

## Waivers

A waiver is first-class, not a workaround — record it here, not in a side channel.

| Gate | Reason for waiver | Committed fix date | Approver | Date approved |
|---|---|---|---|---|
| | | | | |

Add a row per waived gate. A waiver with no committed fix date is not a waiver — it's an unaddressed NO-GO wearing a GO badge. Do not proceed past HG-6 on a waiver unless the reason explicitly establishes there is no destructive migration in this cutover.

## Overall decision

| Cutover | Date | All 6 gates GO or waived-with-date? | Decision | Approver | Client witness (optional) |
|---|---|---|---|---|---|
| | | | | | |

## Closing rule

This sheet links; it does not restate. If a gate's state changes (a test starts failing, a new migration lands, a security exception expires), **update the owning file first** (the CI run, `SECURITY.md`, the migrations directory, `testing-log/`) — do not hand-edit a pass/fail word into this table. Re-evaluate the row from its link at cutover time.

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (go/no-go decision) | | | |
| Client witness (optional) | | | |

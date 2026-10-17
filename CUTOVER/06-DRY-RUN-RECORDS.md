# 06 · Dry-Run Records

**Status: ACTIVE (format spec)** · the records themselves are **not** in this folder — see "Where records live" below.

A cutover rehearsal record proves a cutover step was walked through — command run, output seen, decision made — before it's executed for real. This file is the format spec only; it owns no actual run data (one status lives in exactly one file — the discipline this repo runs on).

## What counts as a dry run

Any of:
- Walking [02-DEPLOY.md](02-DEPLOY.md) or [01-INSTALL.md](01-INSTALL.md) against a non-production target (local, a scratch Supabase project).
- A restore drill per [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md).
- A `nopm` CLI **`--curl` dry-run** — printing the exact request that a cutover-adjacent write (e.g. minting a PAT, locking a project) would send, without sending it. See `cli/README.md` ("`--curl` — print the equivalent curl command instead of sending it, token masked as `$NOPM_TOKEN`") and `cli/nopm.mjs` (`isDryRun` — the dispatcher exits 0 after printing, nothing is sent). Useful to sanity-check a scripted cutover command against the live API contract without mutating anything or spending a rate-limit budget.

## Record format

Each dry-run record is a single markdown file inside a **dated, immutable** evidence folder (never edited after the fact — a correction is a new record, not a rewrite):

```
testing-log/<YYYY-MM-DD>_<what-was-rehearsed>/
  RECORD.md
  (any captured output: .txt/.log files, screenshots)
```

`RECORD.md` fields:

```markdown
# Dry run — <what was rehearsed>

**Date:** <YYYY-MM-DD>  **Run by:** <name>  **Target:** <local | scratch Supabase project | staging>

## Steps followed
- <which CUTOVER/ file + step numbers>

## Commands run + output
```
<verbatim command>
<verbatim output, or a pointer to a captured .log file in this folder>
```

## Result
PASS / FAIL / PARTIAL — <one line>

## Follow-ups
- <anything the real cutover needs to account for as a result of this dry run>

**Signature:** <name>, <date>
```

## Where records live

Records themselves live in dated folders under **`testing-log/`** at the repo root (e.g. `testing-log/2026-MM-DD_deploy-dry-run/RECORD.md`), not under `CUTOVER/`. This file is the pointer + format spec; `testing-log/` is the evidence trail (a sibling deliverable — see `CUTOVER/README.md`'s checkpoint table for its status). Keep dry-run folders immutable once written: if a later run finds something new, add a new dated folder rather than editing an old one.

## Runs

### 2026-10-17 — lark wave, `--atomic --dry-run` (live project)

**Date:** 2026-10-17  **Run by:** the owner's Claude Code session, with the owner's explicit approval in chat for the merge of each PR and for the live rollout  **Target:** the live `nopm` Supabase project. The connection string was derived from the owner's `web/.env.local`; the read-only pre-check confirmed the 45-row live ledger before anything was applied.

**Steps followed:**
- [`07-LARK-WAVE-ROLLOUT.md`](07-LARK-WAVE-ROLLOUT.md) section 2 (pre-check) and section 4, step 2 (dry run)

**Commands run + output** (command per 07 step 2):

```
node scripts/migrate.mjs --atomic --dry-run
apply 20261016000045_principal_four_eyes.sql ...
  NOTICE: 0045: 6 deletion request(s), 1 change request(s), 0 timesheet(s) were decided by the same human who raised them (kept as history; blocked from now on)
ok (150 ms)
apply 20261016000046_integration_hub.sql ... ok (80 ms)
apply 20261016000047_calendar_feeds.sql ... ok (34 ms)
apply 20261017000049_lifecycle_guards.sql ... ok (38 ms)
apply 20261017000050_truncate_guard.sql ... ok (38 ms)
apply 20261017000051_hub_reliability.sql ... ok (35 ms)
apply 20261017000052_api_tokens_kind.sql ... ok (41 ms)
apply 20261017000053_hub_card_integrity.sql ... ok (32 ms)
apply 20261017000054_lifecycle_guards_2.sql ... ok (34 ms)
Dry run complete in 623 ms: 9 pending file(s) applied cleanly, then ROLLED BACK. Nothing changed.
```

**Result:** PASS. Nine pending files applied cleanly and were rolled back. The 0045 notice (6 deletion, 1 change request, 0 timesheets) matched pre-check F1–F3.

**Follow-ups:**
- The captured output is not yet filed under `testing-log/`. The owner files it as a dated record folder, per "Where records live" above.
- The live window itself is recorded in [`07-LARK-WAVE-ROLLOUT.md`](07-LARK-WAVE-ROLLOUT.md), "Run record — 2026-10-17".

**Signature:** TODO (owner), 2026-10-17

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner | | | |
| Client witness (optional) | | | |

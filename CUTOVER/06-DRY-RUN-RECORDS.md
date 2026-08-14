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

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner | | | |
| Client witness (optional) | | | |

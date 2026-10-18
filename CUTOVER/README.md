# CUTOVER — go-live command center

**Status: ACTIVE**

This folder is the front door for taking NoPM from a checked-out commit to a live, verified production state — and for reversing that safely if it goes wrong. It does not restate facts that live elsewhere (env vars, migration internals, test counts); it links to the file that owns each fact and tells you what order to read things in.

## The four-queue idea, adapted lite

Enterprise cutover command centers typically run four **staffed** workstream queues in parallel during a live cutover window (e.g. infra/build, data/migration, functional/business, command). NoPM is a single-owner portfolio project, so that's adapted down to **four states**, not four staffed teams — every checkpoint below sits in exactly one of them at any time:

| Queue | Meaning |
|---|---|
| **NOT STARTED** | Not yet attempted for this cutover. |
| **IN PROGRESS** | Being worked — commands run, evidence being gathered. |
| **BLOCKED** | Stuck on a decision or a failing gate — needs the owner (or, if applicable, a client witness) before it can move. |
| **DONE** | Verified and signed off — evidence exists (a link, not a restated claim) and a signature is on file. |

A real cutover walks every checkpoint in the table below from NOT STARTED to DONE, in order, before flipping [05-GO-NO-GO.md](05-GO-NO-GO.md)'s overall decision to GO.

## Checkpoint table

| File | Done-when | Signature |
|---|---|---|
| [01-INSTALL.md](01-INSTALL.md) | A clean clone reaches a running app with `GET /api/health` returning `ok` and `auth-smoke.mjs` green, following the managed path only (self-hosted is a documented Wave-3 stub). | see file footer |
| [02-DEPLOY.md](02-DEPLOY.md) | Migrations are applied to the target DB, `vercel deploy --prod --yes` has run from `web/`, and post-deploy health + auth-smoke are green against the live URL. | see file footer |
| [03-ROLLBACK.md](03-ROLLBACK.md) | For a given failure, the correct row in the decision table has been identified and (if executed) followed — app rollback via Vercel instant-rollback, DB rollback via restore-from-backup only, respecting the version-skew ordering rule. | see file footer |
| [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md) | A `supabase db dump` (or a named PITR timestamp) exists from **before** this cutover's migrations, and a restore drill has been run at least once with its evidence filed under `testing-log/`. | see file footer |
| [05-GO-NO-GO.md](05-GO-NO-GO.md) | All six hard gates (HG-1..HG-6) are GO or waived-with-a-committed-date, and the overall decision row is signed. | see file footer |
| [06-DRY-RUN-RECORDS.md](06-DRY-RUN-RECORDS.md) | At least one dry run of the deploy procedure (or a `nopm --curl` dry-run of any cutover-adjacent write) has a dated record filed under `testing-log/`. | see file footer |
| [07-LARK-WAVE-ROLLOUT.md](07-LARK-WAVE-ROLLOUT.md) | Release-specific, only for the build that carries migrations 0045–0054: pre-check gates passed, the migrations were applied in one transaction (`migrate.mjs --atomic`), the post-check is all `ok`, and the new build was promoted only after that. SQL lives in [`sql/lark-wave/`](sql/lark-wave/). | see file footer |
| [10-COMMON-PATTERN-ANSWERS.md](10-COMMON-PATTERN-ANSWERS.md) | Release-specific, only for the build that carries migrations 0076-0081, 0083 and 0084 (decisions 19-25): backup, dry run, apply `--atomic`, deploy, smoke, and the owner's Supabase session-length step. | see file footer |

Each linked file carries its own owner + optional client-witness signature block at the bottom — this table does not duplicate those signatures, only points at them.

## Reading order for a real cutover

1. [01-INSTALL.md](01-INSTALL.md) — if standing up a new environment.
2. [06-DRY-RUN-RECORDS.md](06-DRY-RUN-RECORDS.md) — rehearse first, on a non-production target.
3. [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md) — take the backup, before touching anything live.
4. [05-GO-NO-GO.md](05-GO-NO-GO.md) — walk all six gates.
5. [02-DEPLOY.md](02-DEPLOY.md) — migrate, then deploy, then verify. For the build that carries migrations 0045–0054, follow [07-LARK-WAVE-ROLLOUT.md](07-LARK-WAVE-ROLLOUT.md) instead of the plain deploy step: its order and window shape differ.
6. [03-ROLLBACK.md](03-ROLLBACK.md) — keep open in a tab. You hope not to need it.

## What this folder is not

- Not a restatement of `web/.env.example`, the migration SQL, or the test suite — those are linked, never copied.
- Not the evidence trail itself — dated dry-run/restore-drill records live in `testing-log/` (a sibling deliverable to this folder), not here.
- Not the self-hosted install/backup path — both are explicitly stubbed with a Wave-3 commitment (see [01-INSTALL.md](01-INSTALL.md) and [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md) bottoms, and `requirements/devops-wave1/README.md` Decision 7).

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (folder reviewed/current) | | | |
| Client witness (optional) | | | |

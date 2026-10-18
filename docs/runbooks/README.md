# Runbooks — index

**Status: ACTIVE**

`docs/runbooks/` holds repeatable operational procedures — the "how do I actually do X against this workspace" playbooks — as distinct from `CUTOVER/` (the one-time-per-cutover go-live sequence) and `testing-log/` (evidence that a run happened). A runbook here is meant to be followed the same way every time it's needed, not written fresh each time.

| Runbook | Status | Covers |
|---|---|---|
| [`user-provisioning.md`](user-provisioning.md) | ACTIVE | How a person's login + role gets created today (Supabase Auth + `profiles` row), and the planned link-based invite flow |
| [`backup-restore-drill.md`](backup-restore-drill.md) | DRAFT | Step-by-step DB backup/restore drill procedure + evidence/sign-off; canonical owner of the drill steps — [`CUTOVER/04-BACKUP-RESTORE.md`](../../CUTOVER/04-BACKUP-RESTORE.md) links here rather than restating them |
| [`lark-first-live-test.md`](lark-first-live-test.md) | DRAFT | The first end-to-end run of the Lark / Feishu integration against a real tenant: app setup, long connection then webhook, smoke test, and the open questions only a live tenant can settle |

## Status legend

Same legend used across this repo's runbook-style folders (`CUTOVER/`, `testing-log/`):

| Status | Meaning |
|---|---|
| **ACTIVE** | Current, verified against the live app/scripts, safe to follow as-is. |
| **DRAFT** | Written but not yet exercised end-to-end — the procedure is believed correct but has no evidence run backing it yet. |
| **STUB** | Placeholder only; the real procedure doesn't exist yet (commonly paired with a Wave commitment elsewhere). |
| **SUPERSEDED** | Replaced by a newer runbook; kept for history, linked from its replacement. |

## What this folder is not

- Not the go-live sequence — that's [`CUTOVER/`](../../CUTOVER/README.md), which links into here where a runbook already owns a procedure (e.g. the backup/restore drill).
- Not the evidence trail — dated drill/UAT records live in [`testing-log/`](../../testing-log/README.md), linked from the runbook that produced them, never copied here.
- Not requirements or scope — see `requirements/`.

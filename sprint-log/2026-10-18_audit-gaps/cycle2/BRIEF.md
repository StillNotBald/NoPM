# UAT cycle 2 — shared brief for every builder, reviewer and tester

Repo: `<repo>` (branch `fix/uat-cycle-2-2026-10-18`, off public main `a0fd35a` which is LIVE on stillnotbald.com since 2026-10-18 20:09 MYT). App in `web/`. Read `CLAUDE.md` at the repo root first.

## What this cycle delivers
1. Fixes for the OPEN cycle-1 findings UAT-029..034 in `UAT-log/01-FINDINGS.md` (repo root `UAT-log/`).
2. The owner's decisions recorded 2026-10-18 20:15 MYT at the end of `sprint-log/2026-10-18_audit-gaps/CHANGE-REQUEST.md` (Q1 emergency = flag only, no approval; Q4 approved documents = manager tier; Q5 expense deletion over threshold = high risk; Q7 GitHub never completes a task). Q2 and Q8 are NOT built this cycle. UAT-034 is superseded by Q1.

## Hard rules (these bit us in cycle 1)
- NEVER run `git stash`, `git checkout`, `git reset`, `git clean`, `git commit`, `git push`. The tree is shared with other builders working in parallel. The lead commits.
- Edit only files inside your ownership list. If a fix needs a file outside it, write what is needed in your RTM note (`rtm/c2-<you>.md`) and stop at the boundary. Exception: tests that live next to a file you own.
- `web/src/app/api/openapi.json/route.ts` and `web/src/app/llms.txt/route.ts` are edited by NOBODY this cycle: write the needed wording in `rtm/c2-<you>-openapi-notes.md`; a docs pass applies them at the end.
- Never create `web/.env.local`. Never stage `web/supabase/config.toml` or `web/supabase/.gitignore`.
- No model-family names in prose or comments (write "builder agent"); no client codenames. `scripts/commit-gate.mjs` blocks them.
- RTM bullets (`sprint-log/2026-10-18_audit-gaps/rtm/c2-<you>.md`) follow the shape of `rtm/w4d.md`: `- **R-1xx** <title>. Acceptance: … — **DONE**` with plain file paths, never brace globs. Cycle 2 R-IDs start at **R-155** and are assigned in the per-builder prompt.
- Migrations: next free number is `20261018000106_*.sql`; only the builder told to write a migration writes one. Every migration must be additive, idempotent (`if not exists`, `create or replace`), and must not fail on live data (live has real rows at ledger 0105).
- Behaviour that changes WHO can approve WHAT is enforced in the database (RPC / trigger / CHECK) AND in the route, never UI-only.
- Every change gets an audit row through the existing audited write path (`nopm_mutate_audited` wrapper in `web/src/lib/audit/audited-write.ts`) where it mutates.
- Gates before you report done, run from `web/`: `npx tsc --noEmit -p .` (0 errors), `npx vitest run <your test files>` (green), `npx eslint <your files>` (0 errors). Do NOT run the full suite (6,600 tests) — the lead does.
- Update `UAT-log/02-ROOT-CAUSES.md` with a row per finding you fix (ID, root cause, fix, files). Do not change `01-FINDINGS.md` status (the lead does after retest). Append owner-visible screen changes to `sprint-log/2026-10-18_audit-gaps/OWNER-VISIBLE.md` under a "Cycle 2" heading (create the heading if missing; one builder may add it, the others append below).

## Local stack (for anyone who needs a running app)
Local Supabase is RUNNING with cycle-1 data (ledger 0105). Dev server RUNNING on http://localhost:3000 with `DEMO_EMAIL=demo@example.com`, `ADMIN_EMAIL=admin@example.com`, fake Lark override on 127.0.0.1:18080. Env file (loopback keys only): `$NOPM_UAT_ENV` (source it with `set -a; source <file>; set +a`). Sessions are minted by magic link with the service key (see `web/e2e/global-setup.mjs`); seeded users: admin@example.com (admin), demo@example.com (demo manager), priya.nair@stillnotbald.com, daniel.okoro@stillnotbald.com, uat-a-member@example.com (member). Always `BASE=http://localhost:3000`; never point anything at stillnotbald.com. Direct SQL: `docker exec supabase_db_web psql -U postgres -d postgres -Atc "<sql>"`. If the dev server needs a restart (recompile loop: thousands of "Compiled in" lines with no change), tell the lead; do not kill processes yourself.

## Report back (keep it short)
Findings fixed, files touched, migration (if any) with the exact behaviour on existing rows, gates output (tsc/vitest/eslint counts), anything you could not do and why, and the exact RTM note path.

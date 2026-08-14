# Sprint Summary — 2026-08-14_devops-wave1a

**TL;DR:** Wave 1a governance fixes shipped — triplicate project-lock enforcement, baseline DB-backed rate limiting (with the 429 contract), workspace indexes, and a completion-rollup trigger guard — plus the OpenAPI/RTM contract sync this constitution requires in the same commit.

## Declared goals
- Fix 1: close the verified project-lock holes (task/milestone create/patch/delete, dependency add/remove, the `is_locked` generic-PATCH bypass) — enforced in triplicate (R-IDs: R-65)
- Fix 3: baseline API rate limiting, DB-backed, workspace+actor-class keyed, fail-open+loud+audited, 429 added to the JSON contract (R-IDs: R-66)
- Fix 4: `workspace_id` indexes on the 10 tables token-actor (PAT) callers filter by, missed because the admin client bypasses RLS (rolled into R-65's migration set as a companion ops item)
- Fix 5: guard the completion-rollup trigger so a task edit that touches none of the rollup formula's input columns no longer pays a full project-wide recompute (rolled into R-65's migration set as a companion ops item)
- Contract sync: RTM rows, OpenAPI write-route descriptions, and this receipt, same wave

Locked-decisions reference: `requirements/devops-wave1/README.md` (owner-resolved 2026-08-14, section "Decisions — RESOLVED"). This task did not re-litigate or deviate from any of the eight resolved decisions there.

## Actual outcomes
- **Project lock, triplicate (R-65).** `web/src/lib/governance/lock.ts` (`assertProjectUnlocked` + `touchesScheduleShape`) is the single API-layer guard, called from every task/milestone/dependency write route. `updateProjectSchema` no longer accepts `is_locked` at all (silently stripped, not validated) — lock state changes only through the dedicated lock/unlock routes. Migration `20260814000028_project_lock_enforcement.sql` adds the DB-level backstop: six triggers across `tasks`/`milestones`/`task_dependencies` (unconditional on INSERT/DELETE, `IS DISTINCT FROM`-guarded on UPDATE) raising `PROJECT_LOCKED` (errcode `P0010`) if the write reshapes a locked project's schedule. A transaction-local `nopm.lock_bypass` GUC is the one carve-out, scoped to the new `nopm_apply_rebaseline_snapshot` RPC that the rebaseline-apply route now calls (replacing a per-row `.update()` loop that couldn't have carried a transaction-scoped bypass). The four-eyes deletion-commit path deliberately gets **no** bypass — a commit against a since-locked project rolls back loudly, mapped to a 422 `RuleError` in the approve route. Every blocked-write route audits a fail-soft `*.blocked` row (`task.create.blocked`, `milestone.update.blocked`, `dependency.delete.blocked`, etc.) via the `onBlocked` callback on `assertProjectUnlocked` — try/catch'd so an audit hiccup never masks the 422 or, worse, lets the write through.
- **Rate limiting (R-66).** `web/src/lib/api/rate-limit.ts` calls a new DB-backed fixed-window RPC (`nopm_rate_check`, migration `20260814000029_rate_limiting.sql`, modeled on the existing `nopm_demo_rate_check` row-locked pattern) keyed `workspaceId:actorType:bucket` (read/write split by HTTP method) so the cap survives serverless cold starts/parallel instances and the BYOK assistant's per-turn ephemeral tokens. Wired into `route()` right after actor resolution. Fails **open** (logs loudly, request proceeds) on RPC/infra error; fails **closed** with a new `RateLimitError` (429, code `rate_limited`) on an actual limit hit, with a fail-soft `rate.limited` audit row. Contract bundled same-commit: `errors.ts` gains `RateLimitError`, `openapi.json` gains `components.responses.RateLimited` plus a spec-level description note.
- **Workspace indexes + rollup guard (companion ops migrations, same wave).** `20260814000030_workspace_indexes.sql` — plain `CREATE INDEX IF NOT EXISTS` (not `CONCURRENTLY`; the migration runner wraps files in one transaction, which forbids it) on the 9 tables missing a `workspace_id` index (`project_budget` excluded — `project_id` is its PK). `20260814000031_rollup_trigger_guard.sql` splits the single unconditional `trg_tasks_completion_rollup` (0021) into three per-event triggers, `WHEN`-guarding the UPDATE trigger to the four columns the rollup formula actually reads (`status_type`, `completion_pct`, `estimate_hours`, `project_id`) so unrelated task edits (name/description/priority autosave) stop paying a project-wide recompute; the cross-project-move case stays covered because `project_id` is in the guard list.
- **Contract sync (this task).** `requirements/REQUIREMENTS.md` gains R-65/R-66 in the Governance backbone section (highest prior R-ID was R-64); `requirements/TRACEABILITY.md` mirrors both rows with the real files touched and the tests that verify them; `npm run rtm:verify` passes (56 R-IDs status-matched, 275 code-file paths verified on disk). `web/src/app/api/openapi.json/route.ts` write-route descriptions for tasks create/patch/delete, milestones create/patch/delete, and dependencies post/delete each gained a one-clause `422 project_locked` note plus a matching `422` response entry; the drift-coverage tests (`openapi-coverage.test.ts`, `assistant/tools-openapi.test.ts`) don't pin exact description text, so this was a safe additive edit.

## R-IDs touched
- R-65 → DONE (new — project-lock enforcement, triplicate)
- R-66 → DONE (new — baseline API rate limiting)

## Commit map
_Filled at LAND._ This task (T5-rtm-docs-receipt) made no git commits — workers in this wave do not run git. The main session maps this sprint-log entry to the actual commit(s) that land the working-tree diff (governance lock, rate limiter, the four migrations, and this doc/contract sync) when it commits.

## Files
- `requirements/REQUIREMENTS.md` — R-65, R-66 rows added (Governance backbone section)
- `requirements/TRACEABILITY.md` — mirrored R-65, R-66 rows (code + tests columns)
- `web/src/app/api/openapi.json/route.ts` — 422 `project_locked` clause on 7 write operations (tasks create/patch/delete, milestones create/patch/delete, dependencies post/delete)
- `sprint-log/2026-08-14_devops-wave1a/SPRINT_SUMMARY.md` — this receipt

Files this task read but did not modify (already landed by earlier wave-1a tasks, verified via `git diff`/`git status`): `web/src/lib/governance/lock.ts` + `lock.test.ts` + `lock-db-backstop.test.ts`, `web/src/lib/api/rate-limit.ts` + `rate-limit.test.ts`, `web/src/lib/api/errors.ts` (+`.test.ts`), `web/src/lib/api/handler.ts`, `web/src/lib/schedule/completion-rollup-guard.test.ts`, `web/src/app/api/projects/_schema.ts`, `web/src/app/api/{tasks,milestones,projects}/**/route.ts`, `web/src/app/api/deletion-requests/[id]/approve/route.ts`, `web/src/app/api/rebaselines/[id]/apply/route.ts`, `web/supabase/migrations/20260814000028_project_lock_enforcement.sql`, `..029_rate_limiting.sql`, `..030_workspace_indexes.sql`, `..031_rollup_trigger_guard.sql`.

## Tests / verification
- `cd web && npm run test` — **40 files / 1,063 tests passed** (up from 1,021 at the end of the maker-withdraw sprint; wave-1a's own new suites — `rate-limit.test.ts` 8, `governance/lock.test.ts` 15, `governance/lock-db-backstop.test.ts` 11, `schedule/completion-rollup-guard.test.ts` 6, plus expanded `errors.test.ts`/`schemas.test.ts` cases — account for the delta).
- `cd web && npx tsc --noEmit` — clean, no output.
- `cd web && node scripts/rtm-verify.mjs` — `RTM OK — 56 R-IDs status-matched, 275 Code-file paths verified on disk.`
- Not run by this task (out of scope for T5 — no git writes, no deploy): migration apply against live Supabase, the locked-fixture live probe, and the limiter burst-test the plan calls for at wave close. These remain the wave's live-verification gate before the wave is considered fully landed (`requirements/devops-wave1/README.md`, "Deploy + live-verify closes the wave").

## Follow-ups (deferred, per the locked plan)
- **Wave 1b** — maker-checker extension to projects only (Decision 3): per-entity/generalized commit RPC migration + audit-action fix + new scopes + OpenAPI + MCP tool catalogue/assistant scope-ceiling re-verification. Explicitly NOT this wave.
- **Wave 2** — folder architecture managed-path docs + folder skeletons + `system_architecture.md` (Decision 7); enterprise onboarding (first-admin bootstrap, seat/role provisioning runbook, audience-split user-manual).
- **Wave 3** — `infra/` (self-hosted Supabase docker-compose, the largest net-new item); backup-restore for the self-hosted path.
- Wave-close live verification (migrate → deploy → auth-smoke → locked-fixture probe → limiter burst-test) — owned by whichever task/session lands and deploys this wave's commit(s).

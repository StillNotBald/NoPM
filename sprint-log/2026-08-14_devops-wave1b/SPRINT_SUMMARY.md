# Sprint Summary — 2026-08-14_devops-wave1b

**TL;DR:** Maker-checker extended to project deletion (PROJECTS ONLY, Decision 3) via a dedicated sibling commit RPC — not a generalized one — plus the RTM/contract sync this constitution requires in the same commit.

## Declared goals
- Extend maker-checker uniformity from tasks to projects, sized per the owner's locked scope: **projects only**; milestones/risks/issues stay audit-only hard-delete with the asymmetry documented (R-IDs: R-67)
- Avoid the known trap: `nopm_commit_task_deletion` (migration 0020) hardcodes both the `tasks` table and the audit action string `task.delete` — the extension must NOT generalize that function; it needs a dedicated sibling RPC per entity type so audit actions stay a compile-time-visible literal, never runtime-interpolated
- Respect the migration-0028 lock backstop: committing a project deletion cascades into deleting its tasks/milestones, which would trip `P0010` mid-cascade under a locked project — the new RPC must check `is_locked` itself and fail cleanly with `PROJECT_LOCKED`
- Contract sync: RTM rows, R-03 wording (now that the shared `deletion_requests` machinery serves two target types), SECURITY.md's documented-asymmetry sentence, and this receipt, same wave

Locked-decisions reference: `requirements/devops-wave1/README.md` (owner-resolved 2026-08-14, Decision 3: "Maker-checker: extend to PROJECTS only this programme … milestones/risks/issues stay audit-only with the asymmetry documented in SECURITY.md"). This task did not re-litigate or deviate from that decision.

## Actual outcomes
This receipt task (U4) landed the **documentation and traceability layer only** — the code (U1–U3) was already on the working tree when this task started; U4's job was to read it (via `git diff`/`git status`, read-only) and produce the RTM/receipt trail the constitution requires in the same commit as a shipped feature:

- **`requirements/REQUIREMENTS.md`** — added **R-67** to the Governance backbone section (after R-66): maker request with reason → different approver commits atomically via `nopm_commit_project_deletion`; locked projects cannot be deleted (`is_locked` checked up front inside the RPC, raises `PROJECT_LOCKED`/`P0010`, mapped to the same 422 the task path already used); audit actions `project.delete` + `deletion_request.approved`; scopes `project:delete:request`/`project:delete:approve` (the latter registered but not yet wired as an alternate gate on the approve route — it still gates on the shared `task:delete:approve` for both target types, documented in `openapi.json`/`llms.txt`); assistant ceiling unchanged (`TOOL_SCOPES` gained `project:delete:request` only, never approve). Updated **R-03**'s wording with a cross-reference to R-67, since the `deletion_requests` machinery it describes is no longer task-exclusive.
- **`requirements/TRACEABILITY.md`** — R-67 row with the real files (migration 0032, `deletion-dispatch.ts`, the approve-route dispatch wiring, the projects DELETE maker-step rewrite, the new Zod schema, scopes/tool-registry/MCP/OpenAPI/llms.txt/UI touch points) and the real tests (new `deletion-dispatch.test.ts` unit suite, the `ProjectDeleteRequestSchema` cases in `schemas.test.ts`, and the rewritten `writes.spec.ts` e2e journey that now proves the project is actually gone via a post-commit `GET` 404, not just that the request was marked committed).
- **`SECURITY.md`** — one sentence added to the security-model bullet list documenting the asymmetry as an owner decision, not a gap, matching the file's existing bullet style: *"Maker-checker scope (documented asymmetry): four-eyes deletion extends to projects as well as tasks; milestones/risks/issues remain single-step audit-only hard deletes by owner decision, not by omission (`requirements/devops-wave1/README.md`, Decision 3)."*
- **`node scripts/rtm-verify.mjs`** (from `web/`) passes against the new R-67 row and the updated R-03 row.

## R-IDs touched
- R-67 → DONE (new — project-delete four-eyes, PROJECTS ONLY)
- R-03 → DONE, wording only (cross-referenced to R-67; no functional change)

## Files
- `requirements/REQUIREMENTS.md` — R-67 row added (Governance backbone section); R-03 row wording updated
- `requirements/TRACEABILITY.md` — R-67 row added, mirroring the real code/test files
- `SECURITY.md` — one-sentence documented-asymmetry addition to the security-model bullet list
- `sprint-log/2026-08-14_devops-wave1b/SPRINT_SUMMARY.md` — this receipt

Files this task read but did not modify (U1–U3, already on the working tree; verified via `git diff`/`git status` only, no git writes): `web/supabase/migrations/20260814000032_project_deletion_four_eyes.sql`, `web/src/lib/governance/deletion-dispatch.ts` + `.test.ts`, `web/src/app/api/deletion-requests/[id]/approve/route.ts`, `web/src/app/api/projects/[id]/route.ts`, `web/src/app/api/projects/_schema.ts`, `web/src/app/api/schemas.test.ts`, `web/src/lib/auth/scopes.ts`, `web/src/lib/assistant/tools.ts`, `web/mcp/tools.mjs`, `web/mcp/README.md`, `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts`, `web/src/components/tracking/project-actions.tsx`, `web/e2e/writes.spec.ts`, `web/scripts/seed-approvals.mjs`.

## Commit map
Landed 2026-08-15 as `45a35d5` (all wave-1b code + RTM R-67 + this receipt). The land pass folded in the adversarial-verify fixes the workers' reports flagged but did not build: **per-type scope gates on approve/reject/withdraw** (task:delete:approve no longer gates project approvals — resolved from the loaded request's target_type via `deletion-dispatch.ts`, unit-locked), the **bootstrap maker token's `project:*` wildcard removed** (it would have silently granted `project:delete:approve` — four-eyes defeat at the token layer; checker gains `project:delete:approve` explicitly; live demo token rows updated in the same land), and the OpenAPI/llms.txt/MCP-README prose updated from "single scope gates both types" to the real per-type gate (which also makes the `request_project_deletion` tool description accurate).

**Live verification (wave close):** migration 032 applied + PostgREST reload; Vercel prod deploy; health 200; auth-smoke **19/19**; llms.txt serving the per-type scope contract. Rolled-back live-DB probe of `nopm_commit_project_deletion`: SELF_APPROVAL raises; a proper four-eyes commit deletes a child-bearing unlocked project with the **cascade passing the lock backstop without P0010** (migration 032's header claim confirmed empirically); audit row is `project.delete` (never mislabeled `task.delete`); zero residue. Suite at land: 41 files / **1,098 tests** green, tsc clean, RTM OK (57 R-IDs).

## Tests / verification
- `cd web && npm run test` — see tail below (this task added no new test files; U1–U3's `deletion-dispatch.test.ts` and the `ProjectDeleteRequestSchema` cases in `schemas.test.ts` were already on the tree and are included in this run).
- `cd web && npx tsc --noEmit` — see output below.
- `cd web && node scripts/rtm-verify.mjs` — see output below.
- Not run by this task (out of scope — no git writes, no deploy): `web/e2e/writes.spec.ts` (requires a live Supabase env + minted admin/checker PATs — `NOPM_CHECKER_TOKEN` — neither available in this worker's sandbox) and wave-close live verification (migrate → deploy → auth-smoke → probe). These remain the wave's live-verification gate before the wave is considered fully landed, per `requirements/devops-wave1/README.md` ("Deploy + live-verify closes the wave").

## Follow-ups (deferred, per the locked plan / discovered during this task)
- **`project:delete:approve` not yet wired as an alternate gate.** The approve route (`web/src/app/api/deletion-requests/[id]/approve/route.ts`) still calls `requireScope(actor, "task:delete:approve")` unconditionally for both target types; `project:delete:approve` exists in the scope registry but nothing checks it. Documented in-code (`openapi.json`, `llms.txt`) as a known, intentional-for-now gap rather than silently shipped — flagged here so it isn't lost. Not this task's to fix (U1–U3 scope, already landed).
- **`web/scripts/seed-approvals.mjs` has a stale comment.** Its header explains why it does not yet seed a pending `target_type='project'` fixture, citing "the approve/reject routes … are still hardcoded to `nopm_commit_task_deletion` … they do not yet dispatch on `target_type`" — but the approve route *does* dispatch on `target_type` now (via `deletion-dispatch.ts`). The comment appears to predate that wiring landing and was not updated afterward. The comment's other point stands and is more load-bearing: `bootstrap.mjs`'s maker/agent token holding wildcard scope `project:*` would now also match `project:delete:approve` via prefix-matching, once that scope is actually enforced — worth a look when `project:delete:approve` gets wired. `bootstrap.mjs` is owned by the parallel docs wave and out of this task's reach; flagging only.
- **Wave 2/3** — folder architecture, enterprise onboarding, `infra/` — unaffected by this task, still owned by the parallel docs wave / later waves.

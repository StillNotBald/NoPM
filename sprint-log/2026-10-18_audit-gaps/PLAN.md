# Audit-gap programme — plan (2026-10-18)

Builds every item the positioning audit (`_docs/directions-2026-10-17/NOPM_AUDIT_REPORT.md`, commit audited 6fd8981) rated PARTIAL, MISSING or STILL PRESENT. Base: origin/main 5a9cc58. Branch: `feat/audit-gaps-2026-10-18`. Discipline: client-build grade (CR record first, same-commit RTM, owner-visible-changes block on every wave, UAT plan a non-developer can run, findings → `UAT-log/01` → `02` → `03`, one review + one fix pass per wave, phone-width render of every new screen).

Change request: [CHANGE-REQUEST.md](CHANGE-REQUEST.md) (CR-2026-10-18-01). Owner assumptions listed there are built as stated and flagged, never silently.

## Ground rules for every agent

- Work ONLY inside `stillnotbald/NoPM-build`. Never open `stillnotbald/NoPM`, `NoPM-deploy`, `NoPM-lark`, `NoPM-intfix`, `NoPM-modules`.
- Never push. The lead commits. Never run `git stash`, `git checkout -- <file>`, `git reset`, `git clean` or any command that rewrites the shared working tree: other agents are editing it at the same time (two stash incidents in wave 1). To see the baseline, read `git show HEAD:<path>` or `git diff`. Never run migrations against any database; migrations are files only, verified by the migration tests (`web/src/lib/governance/*migration*.test.ts` pattern, read-only SQL scans).
- No `python3`. Tests: `cd web && npx vitest run <paths>` for your files, then the full `npm test` once before you report. Typecheck `npx tsc --noEmit`. Lint `npm run lint`.
- Never write any real person's or organisation's name, and never the owner's former employer or its programme names, into any file (`scripts/commit-gate.mjs` enforces a hashed blocklist; run `node scripts/commit-gate.mjs` from the repo root before you report).
- Every mutation writes exactly one audit row via `writeAudit` or inside the RPC. Every new route uses `route()` from `@/lib/api/handler`, `requireScope`, and the `{data}`/`{error}` contract. Token callers filter by `actor.workspaceId`.
- Do NOT edit `requirements/REQUIREMENTS.md` or `requirements/TRACEABILITY.md` directly (collision). Write your rows to `sprint-log/2026-10-18_audit-gaps/rtm/<your-agent>.md` in the exact REQUIREMENTS bullet + RTM table-row format; the lead merges them.
- Do NOT edit files owned by another agent in the same wave (ownership table below). If you must touch a shared file, say so in your report and stop at the boundary.
- Report with: owner-visible changes (added / removed / hidden / renamed / re-ordered, or "None"), files, migrations, tests run with counts, what you could not verify.

## Numbering

- Migrations: next free is `20261018000088`. Ranges are assigned per agent below; never take a number outside your range.
- R-IDs: next free is R-127. Ranges per agent below.
- UAT IDs: minted only in `UAT-log/01-FINDINGS.md`, by the lead, during UAT.

## Wave 1 — foundation (schema integrity, lean payloads, access review)

| Agent | Items | Migrations | R-IDs | Owns |
|---|---|---|---|---|
| W1-A lock-integrity (builder agent) | M7, K3, G6 caveats | 0088, 0089 | R-127, R-128 | `web/supabase/migrations/20261018000088_*`, `..089_*`; `web/src/lib/governance/lock*.ts`, `lock-permissions.ts`; `web/src/app/api/projects/[id]/lock/**`, `unlock/**`; their tests |
| W1-B lean-payloads (builder agent) | A7, K5, K1, K2, K4 | 0090, 0091 | R-129, R-130, R-131 | list routes `web/src/app/api/projects/route.ts`, `projects/[id]/{risks,issues,tasks,milestones}/route.ts`, `risks/**`, `issues/**` list handlers; `risks/_schema.ts`; `web/src/components/forms/risk-form.tsx`; `web/src/app/(console)/risks/**`; `web/mcp/tools.mjs`; `web/src/lib/assistant/tools.ts`; `web/src/app/(console)/tokens/page.tsx` (preset only); OpenAPI/llms coverage tests |
| W1-C access-review-export (builder agent) | M5, M3 (export half), audit CSV columns | none | R-132, R-133 | `web/src/app/api/export/**`, `web/src/lib/export/**`; members/settings page export button; `web/src/app/(console)/trust/**` button; `web/src/lib/people/**` read helpers; their tests |
| W1-D docs (docs agent) | ADR, UAT plan, owner-visible register | none | none | `docs/adr/0016-audit-gap-programme.md`; `sprint-log/2026-10-18_audit-gaps/UAT-PLAN.md`; `sprint-log/2026-10-18_audit-gaps/OWNER-VISIBLE.md` |

Then: one reviewer pass (P0/P1/P2 with file:line), one fix pass by the owning agents, lead merges RTM rows, runs `rtm:verify`, `npm test`, `tsc`, `lint`, commit gate, commits.

## Wave 2 — change-request evidence chain (the moat)

| Agent | Items | Migrations | R-IDs | Owns |
|---|---|---|---|---|
| W2-A implemented-stamp (builder agent) | M2, B1 link, B2 structured scope | 0092, 0093 | R-134, R-135, R-136 | `change_requests` migration (implemented_at/by, CHECK ≥ decided_at; `decision_id` link; `impact_scope` jsonb), `web/src/app/api/change-requests/**`, `web/src/lib/governance/decide.ts` (implement action only), `web/src/components/change-control/**`, decisions ↔ CR link in `decisions/**` |
| W2-B evidence (builder agent) | M4 | 0094 | R-137 | `documents` migration (change_request_id, evidence_type, evidence_result, tested_by, tested_at), `web/src/app/api/documents/**`, documents UI, attach-evidence panel on change detail (coordinate: W2-A owns change-detail.tsx; W2-B adds a self-contained `evidence-panel.tsx` that W2-A mounts) |
| W2-C audit-pack (builder agent) | M3 | none | R-138 | `web/src/app/api/export/**` change_requests entity + audit-pack bundle (CSV zip or multi-CSV), `web/src/lib/reports/**` audit-pack PDF section, `web/src/app/api/reports/**`, UI buttons on change-control + trust |
| W2-D mcp-reads (builder agent) | B7 | none | R-139 | `web/mcp/tools.mjs` + `web/src/lib/assistant/tools.ts`: list_change_requests, get_change_request, list_decisions, get_document (metadata + text when stored), get_evm; `web/mcp/README.md`; coverage tests |
| W2-E docs (docs agent, runs AFTER A–D report) | OpenAPI + llms.txt for every wave-2 route/field (builders leave notes in `rtm/w2x-openapi-notes.md`), UC docs, runbook | none | none | `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts`, `web/mcp/README.md`, `docs/use-cases/UC-10` update, new `UC-21-audit-pack.md`, `CUTOVER/11-AUDIT-GAPS.md` runbook skeleton |

Wave-2 seams: W2-B owns `evidence-panel.tsx` AND the one-line mount in `change-detail.tsx` (done last, re-reading the file first); W2-A never touches the evidence region. Builders do NOT edit OpenAPI/llms (the two coverage tests may fail until W2-E runs; say so in your report instead of fixing them).

## Wave 3 — runs without you

| Agent | Items | Migrations | R-IDs | Owns |
|---|---|---|---|---|
| W3-A handover (builder agent) | M6 | 0095 | R-140 | `backup_owner_id` on projects, risks, issues, tasks; `GET /api/reports/handover` (single-owner-no-backup per project + workspace key-person matrix); MCP `get_handover_report`; CSV; console page `(console)/handover` |
| W3-B nudges-and-reports (builder agent) | A3, A4, A5 | 0096 | R-141, R-142, R-143 | stale threshold in workspace settings; stale nudge → notifications + digest line; weekly report to in-app notification + email preview; cross-project "what changed" console view over `/api/audit` |
| W3-C forecast-and-trends (builder agent) | B3, B6, G5 | 0097, 0098 | R-144, R-145, R-146 | `estimate_to_complete` on project_budget + EAC = AC + committed + ETC (CPI-based kept as alternative); `project_snapshots` table + nightly cron snapshot + drift/slip trend + suggested RAG; review queue assigned-to-me filter + optional `assigned_approver_id` |
| W3-D cross-project (builder agent) | B5 | 0099 | R-147 | `project_dependencies` (depends_on_project_id, kind) + `linked_risk_id` on dependencies; contingent flag rollup in portfolio + program rollup + Mainline edges |
| W3-E docs (docs agent, runs AFTER A–D report) | OpenAPI + llms.txt from `rtm/w3x-openapi-notes.md`, use-case docs for handover, trends, dependencies; UAT-PLAN + OWNER-VISIBLE wave-3 rows; CUTOVER/11 extension | none | none | `openapi.json/route.ts`, `llms.txt/route.ts`, `web/mcp/README.md`, docs |

Wave-3 seams: `integrations/cron/route.ts` + `cron.ts` + `notify/publish.ts` + `workspace-settings/**` = W3-B only; W3-C gets its own `api/cron/snapshots/route.ts` and is the only one to edit `vercel.json`; `web/mcp/tools.mjs` + `assistant/tools.ts` = W3-A only (get_handover_report); portfolio page + program rollup = W3-D only; budget page = W3-C only; project page `(console)/projects/[id]/page.tsx`: W3-A and W3-D each add ONE import + ONE mount line for their own self-contained panel component, done last after re-reading the file; `views.ts`: W3-A adds `backup_owner_id` to the project/risk/issue/task column lists, nobody else touches it. Builders never edit OpenAPI/llms.

## Wave 4 — governance tiers, deletion flow, atomic audit, work events

| Agent | Items | Migrations | R-IDs | Owns |
|---|---|---|---|---|
| W4-A tier-engine (builder agent) | G1, G2, G3, G4, G7 | 0100, 0101 | R-148, R-149, R-150 | `workspace_settings.approval_policy` jsonb (five tiers, approver roles, turnaround hours, auto_approve flag allowed only on routine and OFF by default, currency threshold), `tier` on change_requests / deletion_requests / rebaselines, routing in `lib/auth/approver.ts` + `notify/publish.ts`, cron timer + escalation, emergency status + 48 h retro flag, settings UI |
| W4-B deletion-flow (builder agent) | G8 | 0102 | R-151 | request-not-delete for expenses, documents (approved), risks, issues, milestones; DB trigger refusing a hard delete without an approved request for those tables |
| W4-C atomic-audit (two builder agents, split by route group) | M1 atomicity | 0103, 0104 | R-152 | the 59 mutate-then-audit handlers → RPC or single-statement CTE write+audit; hash chain `prev_hash`/`row_hash` on audit_log via trigger (tamper evidence) |
| W4-D work-events (builder agent) | A1 | 0105 | R-153 | signed GitHub webhook route (`/api/integrations/github/events`), map PR opened/merged/deployed to task status via `external_ref`, connector actor audit, never on locked projects, settings UI for the secret |
| W4-E docs (docs agent, runs AFTER A–D report) | OpenAPI + llms.txt from `rtm/w4x-openapi-notes.md`, ADR 0017 approval tiers, UC docs, CUTOVER runbook fill, UAT-PLAN + OWNER-VISIBLE wave-4 rows | none | none | docs only |

Wave-4 split and seams: W4-C is two agents. **W4-C1** builds migration 0103 (`nopm_mutate_audited` generic single-transaction write+audit RPC with an allowlist of tables, `format('%I')`, column validation against `information_schema`) + the TS wrapper `web/src/lib/audit/audited-write.ts` + converts route group 1 (projects, milestones, tasks, risks, issues, clashes, programs, sprints, allocations, expenses, resources, saved-views, calendar-feeds) — R-152. **W4-C2** builds migration 0104 (audit hash chain `prev_hash`/`row_hash` set by the insert trigger, `nopm_audit_verify_chain()`, `GET /api/audit/verify`, Trust Center badge) — R-154 — and, once W4-C1 reports the wrapper, converts route group 2 (documents, decisions, members, invites, tokens, notifications, integrations connectors/identities, assistant, me, budget, workspace-settings reads only). Both exclude: DELETE handlers of risks/issues/expenses/documents/milestones (W4-B), the raise/decide/implement/deletion/rebaseline governance paths (already RPC; W4-A edits raise + decide for tiers), `workspace-settings` PATCH (W4-A). Ownership: `pending.ts` + approvals page = W4-B (new deletion kinds; it also surfaces W4-A's `tier` and `retro_due_at` columns generically); `lib/auth/approver.ts`, `notify/publish.ts`, `integrations/cron.ts` additions, settings UI approval-policy card, `decide.ts` = W4-A; `deletion-dispatch.ts`, `deletion-requests/**`, the five DELETE routes = W4-B; `integrations/github/**`, `lib/integrations/github/**`, a separate connector card component + one mount line on the integrations page = W4-D; `vercel.json` = W4-A only if a timer cron is needed (prefer the existing daily cron). Migrations: W4-A 0100, 0101; W4-B 0102; W4-C1 0103; W4-C2 0104; W4-D 0105. R-IDs: W4-A R-148–150, W4-B R-151, W4-C1 R-152, W4-D R-153, W4-C2 R-154. Builders never edit OpenAPI/llms or `tools.mjs` (notes to `rtm/w4x-openapi-notes.md`; W4-E applies docs, the lead applies tool notes).

## After wave 4

UAT cycle 1 run by the lead against a local dev server with seed data: every owner-visible screen rendered at 390 px, findings into `UAT-log/01-FINDINGS.md`, root causes `02`, fixes, retest `03`. Then `SPRINT_SUMMARY.md`, PR to main with the owner-visible block, and the CUTOVER runbook for migrations 0088–0105 (apply before the build serves traffic).

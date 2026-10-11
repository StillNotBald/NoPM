# Sprint Summary — 2026-09-06_sprint1-complement-thesis

**TL;DR:** The "complement, not replace" thesis now has a schema seam (external references), provable audit provenance (client channel + request id), uniform governance (audit-coverage invariant, BYOK key audit, immutability regression test, `change:decide` split, governed unlock), public copy that says it, and a Baselines nav page. **Landed 2026-09-06:** committed a0ce060, migrations 0041–0043 applied to the live DB, deployed to stillnotbald.com (<deployment>), live-verified.

## Origin
A six-lens multi-agent positioning review on 2026-09-06 (`docs/research/POSITIONING-REVIEW-2026-09-06.md`) found the thesis "NoPM is the lite governance layer beside Jira/Slack/Teams, anti-ClickUp" was stated nowhere public and had no schema footing, while governance was strong but uneven. Sprint 1 = the five ranked fixes that make the thesis true.

## Declared goals
- External reference seam on core records (R-81, O1)
- Audit provenance: declared client channel + request id (R-82, governance invariant)
- Governance uniformity: audit-coverage invariant, BYOK credential audit, immutability regression test, `change:decide` scope split with actor-typed four-eyes, unlock reason (R-83)
- Complement copy on landing, wedges, case study, login, README, PRODUCT.md, pitch assets, architecture topology, MCP recipe (R-50 amended)
- Baselines page in Governance nav; email previews out of the sidebar (R-78 amended)

## Actual outcomes
Built with AI-assisted development: 5 sequential implementation passes by AI agents, 12 independent adversarial review passes over the 3 high-risk tasks (no cross-model reviewer, since no OpenRouter key was available), then a full manual diff review and a re-run of the complete gate.

Independent adversarial review passes raised 6 real defects, all fixed during review before this receipt:
1. Partial unique index `(workspace_id, source, external_ref)` admitted duplicates when `source` was NULL (Postgres NULLs are distinct) → index now on `coalesce(source, '')`.
2. `nopm tasks ls --external-ref` was a silent no-op (`GET /api/projects/{id}/tasks` ignored the param) → filter added to that route.
3. Task detail chip required both `source` and `external_ref` → renders on `external_ref` alone.
4. `/api/mcp` neither generated nor echoed `X-Request-Id` when absent → shared `resolveRequestId()` used and echoed.
5. Audit-coverage test regex only saw `export const POST` → now also `export (async) function POST` and `export { h as POST }` (three such routes already existed).
6. Immutability test missed `FOR ALL` / clause-less policies and table-level grants on `audit_log` → patterns added.

Claims from the review passes dismissed after checking code: `assistant_credentials` has `unique (user_id)` so `onConflict: "user_id"` is correct; `verifyBearer`/`verifySession` are module-private; the rate limiter never reads `channel`; the audit CSV export names its columns explicitly.

## R-IDs touched
- R-81 → DONE (new)
- R-82 → DONE (new)
- R-83 → DONE (new)
- R-07 → DONE (amended: change:decide split)
- R-50 → DONE (amended: complement copy)
- R-78 → DONE (amended: Baselines nav, email previews relocated)

## Files
- Migrations (applied to the live DB 2026-09-06): `web/supabase/migrations/20260906000041_external_refs.sql`, `20260906000042_audit_channel.sql`, `20260906000043_change_request_actor_identity.sql`
- Provenance: `web/src/lib/audit/channel.ts`, `write.ts`, `web/src/lib/auth/guard.ts`, `web/src/lib/api/handler.ts`, `web/src/app/api/mcp/route.ts`, `cli/lib/api.mjs`, `web/mcp/server.mjs`, `web/src/lib/assistant/{index,fallback}.ts`, Trust Center + audit query/export
- Governance: `web/src/lib/audit/{coverage,immutability}.test.ts`, `web/src/app/api/assistant/credentials/route.ts`, `web/src/lib/auth/scopes.ts`, change-request raise/decision routes, `web/src/app/api/projects/[id]/unlock/route.ts`, `web/src/app/api/rebaselines/_schema.ts`, `web/src/components/tracking/project-actions.tsx`, `cli/commands/{projects,changes}.mjs`, `web/scripts/seed-change-control.mjs`
- External refs: 5 `_schema.ts`, 3 `_query.ts`, 9 routes, `web/mcp/tools.mjs`, 5 CLI command files, `web/src/components/tracking/{detail-panel,activity-table}.tsx`, OpenAPI + llms.txt
- Copy: `web/src/app/{page,login/page,case-study/page}.tsx`, `web/src/components/marketing/wedges.tsx`, `web/src/lib/reports/one-pager.ts`, `README.md`, `docs/product/PRODUCT.md`, `docs/architecture/system_architecture.md` (§2b complement topology), `web/mcp/README.md` (Slack-thread-to-decision recipe), `nopm-pitch-assets/{objection-bank,demo-runsheet,linkedin-series}.md`
- Nav: `web/src/app/(console)/baselines/{page,loading}.tsx`, `web/src/lib/nav/nav-config.ts`, `web/src/app/(console)/my-work/page.tsx`, `web/src/lib/onboarding/hints.ts`, `web/src/components/command-palette.tsx`, `user-manual/operator/03-schedule-and-lock.md`
- Receipts: `requirements/REQUIREMENTS.md`, `requirements/TRACEABILITY.md`, `web/src/lib/metrics.gen.json`

## Tests / verification
- `cd web && npx tsc --noEmit` clean
- `cd web && npm run test` → 82 files, 1870 tests green (was 1823 at c0d99d8)
- `cd web && npm run rtm:verify` → 73 R-IDs status-matched, 540 code paths on disk
- `cd web && npm run lint` → 0 errors (1 pre-existing warning)
- `cd cli && npm test` → 21/21 (6 new contract tests for the external-ref flags)
- Playwright tier 1 vs local production build: 80 passed, 12 skipped (one register-filter test fails only under the dev server: pre-hydration timing, passes on `next start`)
- Playwright tier 2 (`E2E_WRITES=1`) vs local production build + migrated live DB: 91 passed, 1 skipped
- Live DB: `node scripts/migrate.mjs` applied 0041–0043; `notify pgrst` reload; columns + 5 partial unique indexes verified
- Deploy: `vercel deploy --prod --yes` (owner-run), aliased to stillnotbald.com
- Live: `/api/health` ok; `auth-smoke.mjs` 23/23 (now 24 with `/baselines`); Playwright console-pages + public + navigation vs live: 38 passed; landing/login/case-study carry the complement copy; OpenAPI exposes `external_ref` and `change:decide`; audit rows from the write tier carry `channel` + `request_id`

## Follow-ups
- Audit rows written inside Postgres RPCs (deletion commit, invite accept) have NULL `channel`/`request_id` — the RPC signatures need the two values passed through (observed live: `project.delete` + `deletion_request.approved` pair).
- Unauthenticated (401) responses carry no `X-Request-Id` because no actor is resolved; stamp a generated id there too if correlation of auth failures is wanted.
- Tokens page `ALL_SCOPES` is hand-curated and has never listed `change:*`, `document:*`, `saved_view:*`, `assistant:*` — a UI-minted PAT cannot hold `change:decide`. Derive it from the `SCOPES` registry (pre-existing gap).
- `query_audit` MCP tool and `nopm audit` CLI have no `--channel` filter yet (REST does).
- Pitch assets still carry a few old figures in body text (objection bank items 4/6/12/13, linkedin line 4 route/ADR counts).
- R-78 prose says page hints cover "22 console pages"; the registry now has 24 entries.
- Sprint 2 candidates from the review: audit `since`/`after_id` cursor, zod/dnd-kit/realtime out of the shared browser bundle, static `/` and `/login`, Trust Center per-object drill-down, hash-chain + verify endpoint.

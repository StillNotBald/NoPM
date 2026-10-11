# Sprint Summary — 2026-09-06_sprint2-showcase-and-lite

**TL;DR:** Provenance is now complete (RPC-written audit rows and 401s carry a correlation id), the audit log can be tailed by an agent, the Trust Center shows a governance buyer what they ask for with per-object history from every entity, the token mint UI derives its scopes from the registry, and the shared browser shell dropped roughly 284 KB of JS per page. Landing status recorded at the end of this file.

## Origin
Sprint 1 (same day, commit a0ce060) made the complement thesis true in the schema and the API. The positioning review's remaining items were: audit rows written inside Postgres RPCs had no channel, 401s had no request id, the Trust Center showed a timeline and a badge, the tokens page could not mint `change:decide`, every console page shipped about 700 KB of JS, and there was no outbound story without webhooks.

## Declared goals
- R-84 Provenance completeness: RPC audit rows carry channel + request id; 401s carry `X-Request-Id`
- R-85 Audit cursor: `since` / `after_id` / `order` + `channel` on REST, MCP and CLI; "tail the log into Slack" recipe
- R-86 Trust Center buyer view: filters, per-object History links, "What this proves" card; tokens page scopes derived from the registry
- R-87 Browser weight: zod, dnd-kit and the Supabase client out of the shared shell; dependency count on the landing page
- Deferred by decision: static `/` and `/login` (root layout stamps theme from cookie + DB before first paint; restructuring is an ADR)

## Actual outcomes
Built with AI-assisted development: 4 sequential implementation passes by AI agents, 11 independent adversarial review passes over the 3 high-risk tasks, then a full manual diff review and the complete gate.

- **R-84.** Migration `20260906000044_rpc_audit_provenance.sql` drops the old signatures of `nopm_commit_task_deletion`, `nopm_commit_project_deletion` and `nopm_accept_invite` (Postgres would otherwise keep them as overloads) and recreates them with `p_channel` and `p_correlation_id`, an `INVALID_CHANNEL` guard, both audit inserts carrying the two columns, and the service-role-only grant posture re-applied. The worker correctly renamed the second parameter: `p_request_id` already names the deletion-request row id. Callers thread `actor.channel` / `actor.requestId`; the anonymous invite-accept route resolves them from headers. `route()` stamps a generated `X-Request-Id` on 401s for authenticated routes. New tests: `rpc-provenance.test.ts` (migration-text drift + forward guard), `handler.test.ts`.
- **R-85.** `GET /api/audit` accepts `since`, `after_id` (404 for a row outside the caller's workspace, indistinguishable from missing) and `order`; export applies `since`/`order` consistently; MCP `query_audit` and `nopm audit` gained the same filters plus `channel`; recipe in `web/mcp/README.md`.
- **R-86.** Trust Center: GET-form filter bar (channel, action), per-object history chip, CSV export carries the active filters, "What this proves" card (retention, provenance, fail-closed honesty, export). History links from task, risk, issue and project. `scopeChoices()` derives the tokens page list from `SCOPES`, covering every scope (test-locked).
- **R-87.** Measured on a clean `next build` (client chunks referenced per route): /trust 722 KB → 438 KB, /tasks 750 → 465, /dashboard 757 → 473, /projects/[id] 853 → 615, /tokens 737 → 695. dnd-kit and supabase-js are confirmed out of the shared chunk. zod remains in it because three forms outside `components/forms/` (change, decision, document) import their server schemas; that is the next cut. Landing page now shows "15 runtime dependencies, 0-dependency CLI" from generated metrics.

### Verification notes
- Independent adversarial review: T1 4/4 confirmed, T2 3/3 confirmed, T4 3/4 confirmed. The one dissenting vote on T4 claimed the new files were missing and typecheck failed; it had attempted a reproduce step that the permission classifier blocked and judged a state it never had. Files present, typecheck clean, verified on manual review.
- Playwright tier 1 on the new build first failed 3 tests (register sort, column chooser, sidebar links). Cause: the shared admin identity's `user_preferences` row carried `columns.tasks=[name,status_type]` and `nav.mode=essentials` left by the previous write-tier run. The preferences PUT is a merge-upsert (R-80), so the write test's "restore previous config" could not remove the keys it added. Fixed the two tests (`writes.spec.ts` restores task columns explicitly; `f2a-features.spec.ts` re-checks Priority in a `finally`) and reset the row. Pre-existing hygiene bug, not a Sprint 2 regression.

## R-IDs touched
- R-84, R-85, R-86, R-87 → DONE (new)

## Files
- Migration: `web/supabase/migrations/20260906000044_rpc_audit_provenance.sql`
- Provenance: `web/src/lib/api/handler.ts`, `web/src/app/api/deletion-requests/[id]/approve/route.ts`, `web/src/lib/governance/invite-accept.ts`, `web/src/app/api/invites/accept/route.ts`, `docs/SECURITY.md`
- Cursor: `web/src/app/api/audit/{route,_query}.ts`, `web/src/app/api/export/route.ts`, `web/mcp/tools.mjs`, `cli/commands/audit.mjs`, OpenAPI + llms.txt, `web/mcp/README.md`
- Trust: `web/src/app/(console)/trust/page.tsx`, `web/src/components/tracking/{detail-panel,project-actions}.tsx`, `web/src/components/registers/{risk,issue}-detail.tsx`, `web/src/lib/auth/scopes.ts`, `web/src/app/(console)/tokens/page.tsx`, `user-manual/operator/04-approvals-and-trust.md`
- Bundle: `web/src/lib/forms/validate.ts`, nine `web/src/components/forms/*-form.tsx`, `web/src/components/layout/{bottom-nav,bottom-nav-sortable,account-menu}.tsx`, `web/src/components/notifications/bell.tsx`, `web/scripts/gen-metrics.mjs`, `web/src/app/page.tsx`, `web/src/lib/metrics.gen.json`
- Tests: `web/src/lib/audit/rpc-provenance.test.ts`, `web/src/lib/api/handler.test.ts`, `web/src/lib/forms/validate.test.ts`, extended governance/scopes/audit query tests, `web/e2e/{writes,f2a-features}.spec.ts`
- Receipts: `requirements/REQUIREMENTS.md`, `requirements/TRACEABILITY.md`

## Tests / verification
- `npx tsc --noEmit` clean; `npm run test` 85 files, 1920 tests; `npm run rtm:verify` 77 R-IDs, 578 paths; lint 0 errors; CLI 23/23; `gen-metrics --check` fresh
- Playwright tier 1 (local production build, after the preferences reset): 80 passed, 12 skipped
- Playwright tier 2 (`E2E_WRITES=1`, local production build + migrated live DB): 91 passed, 1 skipped
- Live DB: `node scripts/migrate.mjs` applied 0044; `notify pgrst` reload; the three RPCs exist once each with the new 6/7-argument signatures, no overloads

## Follow-ups
- zod still in the shared client chunk via `change-form`, `decision-form`, `document-form` importing server schemas; `/tokens` and `/settings` still import the Supabase client through `use-require-session.ts`. Both are the next bundle cut.
- Static `/` and `/login` need an ADR: move the pre-paint theme stamp out of the root layout.
- Hash chain + `/api/audit/verify` (ADR-level).
- Preferences PUT merge cannot remove keys; consider an explicit reset verb or `null` semantics for register keys.

## Landing status
- Committed 77933b5 and pushed to main 2026-09-06 (pre-push gates green).
- Deployed to stillnotbald.com the same day (Vercel deployment <deployment>). Note for the record: the deploy was triggered by an unintended command substitution in a local script, not run manually; the deployed artefact was the same fully-tested commit; the script has since been fixed.
- Live verification: `/api/health` ok; a 401 echoes a supplied `X-Request-Id` and generates one when absent; landing shows "15 runtime dependencies, 0-dependency CLI"; OpenAPI exposes `since` / `after_id` / `order`; `auth-smoke.mjs` 24/24; Playwright console-pages + public + navigation vs live: 38 passed.
- Live DB: RPC-written deletion rows from the write tier carry channel `api` and a shared request id; zero null-channel rows since 0044.

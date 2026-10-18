# UAT cycle 1 - runner C - automated evidence (2026-10-18)

Target: app at http://localhost:3000 (Next dev server) against the local Supabase stack, migrations 0001-0105 plus seed data. No source edited, no git run, dev server untouched, no `web/.env.local` created. Credentials were passed as process env per command.

## Summary table

| Command | Result | Notes |
|---|---|---|
| `node scripts/auth-smoke.mjs` | PASS 23/23 (run with `BASE=http://localhost:3000`) | See "Run mistake" below: the first run, without `BASE`, defaulted to `https://stillnotbald.com`. |
| `npx playwright test` (full suite, sign-out test excluded) | 69 passed, 8 failed, 11 skipped | All 8 failures repeat on re-run. Classified below: 0 product defects, all test drift or environment. |
| `E2E_WRITES=1 npx playwright test e2e/writes.spec.ts e2e/f2b-features.spec.ts` | 9 passed, 4 failed, 1 skipped | One failure repeats the sidebar one. Others: `demo_restricted` 403 (environment) and a collapsed details element (test drift). |
| `demo-login.spec.ts` "demo user can sign out again" | NOT RUN in the clean pass | It revokes all sessions of admin@example.com (DEMO_EMAIL equals ADMIN_EMAIL here), which would log out the other UAT runners. |
| `probe-migrations.mjs` | PASS 9/9 | |
| `probe-four-eyes.mjs` | PASS 29/29 | The wave 1 README recorded 28. |
| `probe-rls-direct-write.mjs` | PASS 23/23 | "direct writes that SUCCEEDED: none". |
| `probe-api.mjs` | 13/15 passed, 2 FAILED | API8, API11. |
| `probe-calendar.mjs` | PASS 10/10 | |
| `probe-lark.mjs` | 34/51 passed, 17 FAILED | LK-X1 plus 16 `LK-EM*` (environment: app not started with the fake-lark override). |
| `probe-github.mjs` | 5/8 passed, 3 FAILED | GH3, GH4, GH6. GH4 exposes a product defect. |
| `GET /api/integrations/cron` (bearer) | 200 | connectors 3, deliveries all 0, digests sent 0 / skipped 3, nudges workspaces 12 / weeklyReports 1 / failed 0, approvals examined 10 / reminders 0 / escalated 0 / failed 0, timedOut 0, elapsedMs 691. |
| `GET /api/cron/snapshots` (bearer) | 200 | `{"workspaces":12,"projects":31,"taken":1,"skipped":30}` |
| API reads with an admin token | Skipped | Minting a PAT is refused for this account (`demo_restricted` 403). Session-cookie reads are covered by auth-smoke (23 pages 200) and the e2e GET checks. |

## Failures, one by one

Classes: PRODUCT goes to UAT intake. ENV is environment. DRIFT means the test or probe is stale against the current product. PRE means already known in `2026-10-18_audit-gaps-wave1/README.md` (it records none of these).

### Playwright, full suite (8)

| # | Test | Assertion (trimmed) | Class | Why |
|---|---|---|---|---|
| 1 | `dialogs.spec.ts:68` Mint-token form is present with scope checkboxes | `locator('input[type="checkbox"]').first()` expected visible | DRIFT | 134 checkboxes exist, but the first sits inside a collapsed details element on /tokens. |
| 2 | `f1-features.spec.ts:35` changing a filter updates the URL (register-filter-builder) | `toHaveURL(/[?&](project_id\|status_type\|priority)=/)` got `/tasks` | ENV | Selecting before hydration on the dev server. By hand with a 3 s wait, Status gives `?status_type=backlog` and Priority adds `&priority=medium`. The feature works. |
| 3 | `f2a-features.spec.ts:115` column chooser hides a visible column | `thead.getByText('Priority', {exact:true})` strict mode violation, 2 elements | DRIFT | The header now holds a sort button and a `th`, both matching. |
| 4 | `f2b-features.spec.ts:37` sidebar exposes the /sprints link | `nav a[href="/sprints"]` expected visible | DRIFT | Sidebar defaults to Essentials mode (R-78). /sprints shows only after "Show all modules". |
| 5-8 | `project-detail.spec.ts:26, 35, 43, 51` (8 tabs, tab switching, kanban, gantt) | `getByRole('button', {name:/^Charter\s?\d*$/})` not found, click timeout | DRIFT | Tabs render as `role="tab"` (`src/components/tracking/project-tabs.tsx:976`); the spec looks for buttons. All 8 tabs are visible in the screenshot. |

### Playwright, write journeys (4)

| Test | Assertion (trimmed) | Class | Why |
|---|---|---|---|
| `f2b-features.spec.ts:37` | same as #4 | DRIFT | |
| `f2b-features.spec.ts:120` invite lifecycle | `createRes.status()` expected 201, received 403 | ENV | Body `{"error":"Not available in the shared demo","code":"demo_restricted"}`. The server treats admin@example.com as the demo identity because DEMO_EMAIL equals ADMIN_EMAIL. |
| `writes.spec.ts:170` mint and revoke a PAT through the tokens UI | `locator.check` timeout 45 s | DRIFT | Checkbox is inside the collapsed details element. The mint would also hit `demo_restricted`. |
| `writes.spec.ts:295` saved view four corners | mint of second identity expected 201, received 403 | ENV | Same `demo_restricted`. |

Not exercised because of the demo restriction: token mint and revoke, invite create/list/revoke, second-identity saved-view privacy. Rerun with DEMO_EMAIL set to a distinct non-admin user.

### probe-api.mjs (2)

- **API8** "B's PAT approves A's request -> 200 ... replay -> 422": `replayed approve (body {"data":{"committed":true}}) (wanted 422, got 200)`. Class: PRODUCT or contract mismatch, needs triage. A replayed approval returns 200 `committed:true` instead of a refusal. It may be intended idempotency, in which case probe and docs disagree. Logged to intake as low.
- **API11** change request, wildcard case: `B PAT decides (body {"error":"Approve and reject must name the version you read (expected_updated_at)...","code":"version_required"}) (wanted 200, got 422)`. Class: DRIFT. The probe does not send `expected_updated_at`, which the API now requires. Same cause as LK-X1.

### probe-lark.mjs (17)

- **LK-X1** "decided in the console first": the same `version_required` 422 as API11. DRIFT.
- **LK-EM0 plus 15 dependent `LK-EM*` checks** (EM1 to EM6 for change_request and task_deletion, EM7): `the app is NOT using fake-lark. Start it with NOPM_LARK_API_BASE_OVERRIDE=http://127.0.0.1:18080`. Class: ENV. The running dev server was not started with the override. Safety note: the connector test answered `credentials rejected: failed to get tenant_access_token, code: 10003`, so the app reached a real Lark host with a fake credential, because the README's dead-port proxy guard was also absent. No tenant data was involved. Restart the dev server with the override and the proxy before the next Lark run. The 34 SQL-seeded and callback checks passed.

### probe-github.mjs (3)

- **GH3** replay: `error: null value in column "status" of relation "tasks" violates not-null constraint`. Class: DRIFT. The probe's own SQL does `update tasks set status = null`, but `tasks.status` is NOT NULL. Replay protection was not exercised.
- **GH4** deployment completes the task: `completed (wanted "completed", got "started")`. Class: PRODUCT. The `work_events` row for the `deploy_success` delivery has `applied=false, reason='error'` after the merge had set the label "In review". Cause: `src/lib/integrations/github/process.ts:129` passes a null label to clear "In review", and the RPC in migration 0105 does `status = case when p_set_label then p_status_label ...`, writing null into `tasks.status`, which is NOT NULL. So a deploy after a merge never completes the task. Logged to intake as high.
- **GH6** locked project is skipped: `new row for relation "projects" violates check constraint "projects_lock_integrity"`. Class: DRIFT. The probe sets `is_locked = true` without a locker, which migration 0088 forbids.

## Run mistakes and isolation problems

1. **First auth-smoke run hit the live site.** I passed no `BASE`, and the script defaults to `https://stillnotbald.com`. It minted a session from the local Supabase and sent 23 read-only GETs with that cookie to the live host. Nothing was written and the cookie is a local-stack token, but treat it as a stray request. It was rerun with `BASE=http://localhost:3000`.
2. **A stuck background Playwright run.** An earlier full run reached the demo "sign out" test, which signs out the shared admin account everywhere, so every later test redirected to /login. I could not stop that run (the process kill was denied). It expires on its own at its 40 minute limit and its results are discarded. The clean results above come from separate runs with their own output folders.
3. **Admin session revocation.** Because of item 2, admin@example.com sessions were revoked once around 16:40 to 16:55 local. Other runners using that account through the UI may have been logged out and need to sign in again.

## Raw evidence

Command tails are in the scratchpad `uat` folder (auth.txt, pw4.txt, pw5.txt, pw6.txt, probe-*.txt). Failure screenshots and traces are in its `pwout`, `pwout2` and `pwout3` folders.


## Retest (2026-10-18, after the fix pass dbead57 and the environment restart)

Environment now: DEMO_EMAIL=demo@example.com (admin is no longer demo-restricted), dev server started with the fake-lark override, 0105 re-applied. Run with `BASE=http://localhost:3000`, local stack env, no `web/.env.local`. The sign-out spec stayed opt-in (E2E_SIGNOUT not set).

| Suite | Before | After | Notes |
|---|---|---|---|
| auth-smoke | 23/0 | 23/0 | |
| Playwright full (sign-out opt-in) | 69 pass, 8 fail, 11 skip | 77 pass, 0 fail, 12 skip | Skips are the opt-in write journeys and the sign-out spec. Further test debt fixed during the retest: persisted nav mode (f2b sidebar), persisted column choice (f2a column chooser). |
| Write journeys (E2E_WRITES=1, writes + f2b) | 9 pass, 4 fail, 1 skip | 13 pass, 0 fail, 1 skip | Token mint, invite create and second-identity saved views now pass (no more `demo_restricted`). The PAT journey needed a test fix for the new "Revoke API token" confirm dialog. |
| probe-migrations | 9/9 | 9/9 | |
| probe-four-eyes | 29/29 | 29/29 | |
| probe-rls-direct-write | 23/23 | 23/23 | no direct write succeeded |
| probe-calendar | 10/10 | 10/10 | |
| probe-github | 5/8 | 8/8 | GH3 and GH6 fixtures fixed; GH4 (deploy after merge) now passes against the re-applied 0105 and the fix pass. |
| probe-lark | 34/51 | 51/51 | The 16 `LK-EM*` checks pass against fake-lark. LK-X1 and LK-EM7 needed `expected_updated_at` in the probe fixture. |
| probe-api | 13/15 | 13/15 | API8 and API11 fail only on the replay check (wanted 422, got 200). Owner decision UAT-018. |
| GET /api/integrations/cron | 200 | 200 | connectors 7, deliveries all 0, digests skipped 7, nudges workspaces 29 / failed 0, approvals examined 37 / failed 0, timedOut 0, elapsedMs 1956 |
| GET /api/cron/snapshots | 200 | 200 | `{"workspaces":29,"projects":56,"taken":25,"skipped":31}` |

### Remaining failures

| Check | Class | Why |
|---|---|---|
| probe-api API8 | Owner decision UAT-018 | Replayed deletion-request approve answers 200 `committed:true`, probe expects 422. |
| probe-api API11 | Owner decision UAT-018 | Replayed change-request decision answers 200, probe expects 422. Everything before the replay step in API11 passes. |

No product defect remains open from the automated suites.

### Retest notes

- Two full Playwright runs in the middle of the retest failed en masse (43 failures, then connection refused from /risks on). The dev server on port 3000 went away for a while during the second run, and the first run overlapped with other activity. Both were discarded; the clean full run is the one counted above.
- Probe-lark LK-EM7 was a stale fixture I missed in the first fix pass (console decision without `expected_updated_at`); fixed in `scripts/local-db/probe-lark.mjs`.
- Test-only edits in this retest: `e2e/f2b-features.spec.ts` (nav mode may already be expanded), `e2e/f2a-features.spec.ts` (start the chooser test from a known state), `e2e/writes.spec.ts` (confirm the revoke dialog), `scripts/local-db/probe-lark.mjs` (EM7).

# Wave 5 UAT: screens and API (2026-10-19)

**Environment:** dev server http://localhost:3000 on the wave-5 tree, local Supabase with migrations through 0114 (direct delete refused with P0040), fake Lark, anchor env unset, one Chromium (Playwright) closed at the end, sessions minted by magic link. Admin = Jordan Hale (the only admin), managers = Demo Manager and Priya Nair. Viewports 390x844 then 1280x800. Scripts `u*.mjs` in this folder. Tester only, nothing fixed, no git.

Counts: 10 must-cover steps. 10 PASS (U3 with the D7 fallback observed), 0 FAIL, 0 BLOCKED. 5 defects/observations logged (0 high, 0 medium, 3 low, 2 info).

| Step | Result | What was seen | Screens |
|---|---|---|---|
| U1 Trust Center anchor | PASS | Badge "Chain verified" plus card "Not anchored: ... Set NOPM_ANCHOR_DB_URL ...". Verify now updated rows to 318 and the check time, no error; second press throttled with "Try again in 2 min". `GET /api/audit/verify` 200 gives `chain_ok:true`, `ok:true`, `anchor.state:"not_anchored"` (the throttled 429 also carries it). | U1-m-1-trust, U1-m-2-after-verify, U1-d-1-trust, U1-d-2-after-verify |
| U2 Audit pack CSV + PDF | PASS (PDF), observation (CSV) | PDF cover has the line "Anchor: not anchored" under the chain head. CSV downloads 200 and has no anchor line (flat table, see D3). Both export 200. | U2-m-audit-pack-panel, U2-d-audit-pack-panel |
| U3 Deletion of five registers | PASS | Manager `DELETE` with `{reason}` on program, sprint, resource, allocation, clash all 202 with the request; program tier `high_risk`, the others `normal`; no reason gives 422. Approvals page lists "Allocation", "Resource" (with "Approving also deletes: 1 allocations") and "Sprint" with human labels. With one admin, a second manager (Priya) approving a program gave 200 and an `approval.fallback_approver` audit row (D7 fallback). With a temporary second admin (reverted), Priya got 403 "Only admins can approve a high-risk request." and admin approve gave 200. Self-approval 403 four-eyes. Direct SQL `delete from programs/sprints/resource_members/allocations` refused with SQLSTATE P0040 DELETE_NEEDS_REQUEST. Resource approval removed its allocation and the `resource.delete` audit row lists it. | U3-m-approvals, U3-d-approvals |
| U4 Task with allocation (PR-01) | PASS | Task with one allocation: manager request 202, admin approve 200, task and allocation gone. | none (API) |
| U5 Blocker reason + ETA | PASS | Task form has "Blocked by", "Blocker reason", "ETA" in order; saved with both; task row shows "Blocked: Waiting on vendor API keys · ETA 30 Oct 2026" at 390 and 1280, no horizontal scroll. | U5-m-1-form, U5-m-2-filled, U5-m-3-saved, U5-d-1-form, U5-d-2-filled, U5-d-3-saved |
| U6 Members export | PASS | Admin CSV last column `last_sign_in_at` (empty for the never-signed-in member); manager CSV has no such column; member 403. | none (API) |
| U7 PAT routes | PASS | Token minted with 12 scopes (the Mint form offers all five `<register>:delete:request` scopes, `document:write`, `change:write`). `POST .../evidence` 201 (evidence_type must be test_result, uat_signoff, deploy_record, screenshot or other); rejected CR gives 422 evidence_not_accepted. `GET /api/documents` has no `body`; `?view=full` has `body`; `?fields=storage_path` 422. `implement` on approved 200 with implemented_at set; on a raised request 422 invalid_transition. A PAT approving a deletion request gets 403 missing task:delete:approve. | U7-m-1-tokens, U7-m-2-tokens-form, U7-d-2-tokens-form |
| U8 Approval policy | PASS | Settings emergency row reads "Commits when raised. No approval. Flagged everywhere."; no retro wording on the page. `GET /api/workspace-settings` has no `emergency_retro_hours`. PATCH carrying it next to a valid field, or inside `approval_policy`, gives 200 and it is ignored. Alone it gives 422 (D5). | U8-m-settings, U8-d-settings |
| U9 Emergency as manager | PASS | Raise returns 201 with status approved, tier emergency, `decided_by` null; audit rows `change_request.create` and `change_request.emergency_commit`. Red "Emergency" badge in the Change Control list at 1280. | U9-m-changes (What changed feed), U10-d-change-control |
| U10 Weekly report and Change Control | PASS | `/api/reports/weekly` renders the weekly status page, no horizontal scroll at 390. Change Control list, tabs, counts and Audit pack button behave as before. | U10-m-weekly-report, U10-d-weekly-report, U10-m-change-control, U10-d-change-control |

Not run (outside the must-cover list): 5G-1 sprint card button, 5G-7 stale child count, 5G-12, 5E dev steps with the anchor on, 5A-6 failure injection.

## Defects

| # | Area | Expected | Actual | Severity |
|---|---|---|---|---|
| D1 | Trust Center stream dates | A UTC-labelled time shows its UTC date | Rows read "19 Oct 2026 ... 16:33:16 UTC" for an event stored 2026-10-18 16:33 UTC; the chain card says "last check 2026-10-18 16:33 UTC". The date part uses the browser's local zone (MYT) while the time is labelled UTC. | Low |
| D2 | Approvals card for an allocation deletion | A readable title for the record | Title reads "Name not recorded" (project shown, allocation has no name). | Low |
| D3 | Audit pack CSV | Anchor state recorded in the pack | CSV carries no anchor line or column; only the PDF cover does. Plan 5E-10 speaks of "the cover", so this may be by design. | Info |
| D4 | `DELETE /api/sprints/<id>` as a member | Plan 5G-8: 403 for members | A member session gets 202 and a pending request (member holds sprint:write; approval stays gated to manager). Confirm this is the intended rule. | Low |
| D5 | `PATCH /api/workspace-settings` | Brief: `emergency_retro_hours` alone gives 200 and is ignored | Alone it gives 422 "Send at least one of: ..."; with any real field it gives 200 and is ignored. | Info |

## Test data left in the local database
Created with the W5UAT prefix: one pending sprint request (raised by the member), one pending allocation request, three stray allocations, two tasks with blocker data, three change requests (one emergency), one evidence document, one PAT named w5-uat-pat (live, local only). The temporary second admin was reverted to member.

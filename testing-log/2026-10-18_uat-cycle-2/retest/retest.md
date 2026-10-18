# UAT cycle 2 retest — fixed emergency paths

**Environment.** 2026-10-18 about 21:50-22:10 MYT (13:10-14:10 UTC). Branch `fix/uat-cycle-2-2026-10-18`. Local stack, dev server http://localhost:3000. Migration 0106 is applied locally (functions `nopm_raise_emergency_change_request`, `nopm_cr_emergency_guard`, `nopm_apply_tier_decisions` exist; P0043 fires). Sessions minted by magic link; API steps via fetch with the session cookie or a PAT; UI steps in a separate headless Chromium (390x844 then 1280x800). Scripts and `results.json` are in this folder; PNGs in `screens/`.

**Result: 12 PASS, 0 FAIL, 1 low-severity defect found on the side (D-1).**

| Step | Result | What I saw | Evidence |
|---|---|---|---|
| T1 (C2-01) | PASS | PAT `change:*`: POST emergency on locked project ERP-EMEA gave 403 `role_not_permitted`, message names `change:decide`, 0 rows created. PAT `change:write`+`change:decide`+`change:read`: 201, status `approved`, tier `emergency`, CR-028. Token ids (not revoked): wildcard `32102a8d-aead-41d3-9e85-bfb72c8f0b5f`, decide `bbe1eba3-781f-4306-ac1d-abde07568a7c` | `results.json` t1* |
| T2 (C2-02) | PASS | Direct insert of an approved emergency row with the member as requester principal: `P0043 EMERGENCY_NOT_PERMITTED: only a manager or admin can raise an emergency change`. UPDATE `is_emergency=true` (and with tier) on a waiting row: `P0043 ... never afterwards`. Both rolled back; CR-002 unchanged | psql verbose output |
| T3 (C2-03) | PASS | Manager raised emergency via UI (CR-029 at 390, CR-030 at 1280). `audit_log` for each has exactly `change_request.create` then `change_request.emergency_commit`, actor Demo Manager, identical timestamp (chain_seq 247/248 for CR-029), no decision rows. Detail shows red Emergency badge, Approved badge, note "Emergency change: committed without approval on 18 Oct 2026 by Demo Manager", "Decided by: Emergency path (no approval required)", zero Approve/Reject/Defer buttons | `screens/t3-390-03-after-submit.png`, `t3-390-04-detail.png`, `t3-1280-04-detail.png` |
| T4 (R7) | PASS | Member POST with `is_emergency: true`: 403 `role_not_permitted` "Only a manager or admin can raise an emergency change."; 0 rows | `results.json` t4 |
| T5 (C2-09, R10) | PASS | Settings > Approval policy: Emergency row reads "Commits when raised. No approval. Flagged everywhere." with "No approver. It commits when raised. Flagged in every list."; no turnaround or retro hours field on it. PATCH `emergency_retro_hours` 48 and 96: 200 both; stored value stays 48 (the pre-existing value), 96 was ignored (checked in `workspaces.approval_policy`). Note: GET still echoes `emergency_retro_hours: 48`; harmless, nothing reads it | `screens/t5-1280-approval-policy.png`, `results.json` t5* |
| T6 (C2-13, R13) | PASS | Audit pack CSV (`GET /api/export?entity=audit_pack&format=csv`, same route as the Change Control button) header has `is_emergency` and `retro_overdue`, no `emergency` column. 28 change-request rows: `is_emergency` is `yes` on emergency tier rows and blank otherwise; `retro_overdue` blank on every row. Retired legacy rows (CR-013, CR-022) show `retro_outcome=retired` | `auditpack.csv` |
| T7 (Q5, R9) | PASS | Threshold is 20000 MYR. Manager DELETE of a 25000 expense: 202, tier `high_risk`; a 500 control expense: 202, tier `normal`. Second manager (Priya Nair) approve on the first run: 200, because the workspace has ONE admin, so the owner's single-admin fallback applies; audit has `deletion_request.approved` plus `approval.fallback_approver` (flag true) by Priya. To prove the refusal path I briefly promoted Daniel Okoro (member) to admin (2 admins), reran: Priya 403 "Only admins can approve a high-risk request." (`role_not_permitted`), admin 200 and expense gone. Daniel reverted to member (verified) | `results.json` t7*, t7b* |
| T8 (Q4, R8) | PASS | Created a document, admin approved it, manager DELETE: 202 tier `normal`, no admin-only refusal; admin approve 200, document gone | `results.json` t8* |
| T9 (Q7, R11) | PASS | Integrations > GitHub card: four selects (PR opened/merged, Deployment succeeded/failed), options are Leave as is, Not started, In progress, In review, Canceled; no Completed. Helper line: "A GitHub event never completes a task; only a person marks it Completed." PATCH `rules.deploy_success="completed"`: 422 "A work event cannot complete a task. Completing a task is a human action; ..."; rules unchanged. Existing connector kept | `screens/t9-1280-github-card.png` |
| T10 (C2-15) | PASS | Manager edited UAT-B1 project, cleared Code, Save: PATCH 200, code stored null, no 422 (390 and 1280). Code restored to `UAT-B1` afterwards. (Raw API with `code:""` still 422s; the UI sends null) | `screens/t10-390-03-saved.png`, `t10-1280-03-saved.png` |
| T11 (UAT-031) | PASS | Screen-reader text once the role has loaded: member "28 items in review"; admin "20 items awaiting your decision"; manager "28 items awaiting your decision". Needs about 10 s on the dev server; before the role loads everyone briefly reads "in review" | `screens/t11-390-*.png`, `results.json` t11* |
| T12 (R12) | PASS | Generated a fresh report (`POST /api/reports/weekly` 200), `GET` HTML: "Emergency changes this week: 8", lists CR-030, CR-029 (the T3 requests), CR-028 and the others, with "Each one committed when it was raised, without an approver, and is flagged here". No "overdue for approval" text, no retro text | `screens/t12-390-weekly.png`, `t12-1280-weekly.png` |

## Defects

| ID | Area | Expected | Actual | Severity |
|---|---|---|---|---|
| D-1 | Integrations > GitHub card intro copy (`web/src/components/integrations/github-card.tsx` line 237) | Copy agrees with Q7: GitHub never completes a task | The intro paragraph, always visible, still says "merging moves it to review, a successful deployment completes it", contradicting the helper line and the rule beneath it | Low (copy only) |

## Data left behind (local DB only)
- Change requests CR-028 (T1), CR-029 and CR-030 (T3). Two PATs (ids above) not revoked.
- Expenses and one document created for T7/T8 are deleted via approved deletion requests; one 500 expense with a pending normal-tier deletion request remains.
- Weekly report snapshot regenerated for week 2026-10-12.
- Daniel Okoro role changed to admin and back to member within one script; Priya Nair approved one high-risk deletion under the fallback.

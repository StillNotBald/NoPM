# UAT cycle 1, tester B, waves 3 and 4

Date: 2026-10-18. Tester: UAT tester B. App: http://localhost:3000 (Next dev server) on the local stack. Screenshots: `shots/` next to this file, named `<step>-<phone|desktop>.png`.

## Totals

| Result | Steps |
|---|---|
| PASS (includes 3-15 partial and 4-23 with defects) | 29 |
| FAIL | 4 (3-9, 4-3, 4-13, 4-21) |
| BLOCKED | 10 (3-7, 4-6, 4-7, 4-10, 4-11, 4-12, 4-14, 4-16, 4-18, 4-22) |

## Setup notes that apply to every step

- **R1, one identity only.** The one-click demo login is the workspace admin (Jordan Hale). The demo account cannot mint API tokens (403 demo_restricted) and no manager or member password is known. Every step marked Manager, Member or Tester was therefore run as the admin. Any step that needs a second human (a different approver, a manager refusal, a member view) is BLOCKED and says so.
- **R2, own browser.** The shared Playwright browser was being driven by another tester, so I ran my own headless Chromium (same Playwright install) against the same app. Phone steps used a 390 by 844 window and confirmed innerWidth 390.
- **R3, test data.** I created projects UAT-B1 to UAT-B8 (UAT-B5 has a backup owner, UAT-B5 depends on B6, UAT-B3 is locked), change requests CR-010 to CR-013, risks R-009 and one more, a milestone with 3 tasks, task links, a GitHub connector, and two deletion requests (one risk, one milestone) left pending. A project deletion request I raised by mistake was refused by the API (project has approved records), so nothing was created. Seed record changed: CDP-CORE forecast to-finish 600000 and method bottom-up. Nothing was deleted.
- **R4, console and width.** On every new or changed screen at 390 px (Handover, Budget, Approvals, Changes, Email previews, Integrations, Trust, Change Control, Portfolio, Project) scrollWidth equalled innerWidth and there were no console errors matching error or hydrat. No CSP or hydration problems in the dev server.
- **R5, screens refresh a few seconds late.** After Save forecast, Remove dependency and similar actions the panel updates 3 to 6 seconds later, not at once. Not logged as a defect.

## Step table

| Step | Result | What I saw | Screenshot |
|---|---|---|---|
| 3-1 | PASS | Seed project IAM-SEC at 390px: amber "No backup owner" badge sits beside status badge, under title, no overlap, scrollWidth 390. Run as admin (see note R1). | 3-1-phone.png |
| 3-2 | PASS | On UAT-B5 (phone) Edit dialog has BACKUP OWNER picker listing the 4 workspace members (incl. the owner) with hint text; chose Priya Nair, saved, badge disappeared, API shows backup_owner_id = Priya. No cut-off, scrollWidth 390. | 3-2-phone.png |
| 3-3 | PASS | Chose the owner as backup: toast "backup_owner_id must be a different person from owner_id" (raw field name in message, cosmetic). Saved value unchanged. | 3-3-phone.png |
| 3-4 | PASS | Handover (phone): summary tiles (90 open, 72 no backup, 17 no owner, 7 single points of failure), key-people cards stack, per-project gaps list with "No owner" group per project. scrollWidth 390. Unowned items are grouped per project rather than one separate list. | 3-4-phone.png |
| 3-5 | PASS | Export CSV downloads nopm-handover-2026-10-18.csv, 97 rows; first column header is section (UTF-8 BOM before it), values item / unowned / person. | 3-5-desktop.png |
| 3-6 | PASS | Integrations > "Nudges and weekly report" card sits below Workspace time zone (not literally beside it). Set stale threshold 3, Save (PATCH 200), reloaded: field shows 3. Note the Approval policy card is on this same page. | 3-6-desktop.png |
| 3-7 | BLOCKED | Daily tick run twice via cron endpoint: nudges.staleNudged = 0 both times. All seed records were created today (2026-10-18) so nothing is more than 3 days stale, and a member login is not available (demo login is admin only; demo account cannot mint tokens). Cannot age a record without direct DB access. | - |
| 3-8 | PASS | "Send weekly report now" shows "Weekly report sent to 2 people." (admin + manager). Admin bell now holds 2 "Weekly status report: week of 2026-10-12" notifications (one from the earlier daily tick, one from the button). Cannot confirm the manager's copy (no manager login). | 3-8-desktop.png |
| 3-9 | FAIL | The bell (phone) shows "You're all caught up / No new notifications" and no badge although the API returns 2 unread weekly-report notifications (HTTP 200 with data). The bell reads data.data/data.total from a helper that already unwraps data. Opened the report link directly instead (/api/reports/weekly?week=2026-10-12): page renders at 390px, scrollWidth 390, project table + milestones + stale items, table 356px wide inside 390. So the report page passes, the notification route to it fails. | 3-9-bell-phone.png, 3-9-phone.png |
| 3-10 | PASS | Email previews renders the weekly report email as a styled preview ("Demo mode", "Previews only - NoPM does not send email"). The stale-item sample could not be checked: no stale notification exists (nothing is stale, see 3-7). | 3-10-desktop.png |
| 3-11 | PASS | What changed: filters Project, Kind, Person, From, To plus Apply/Clear. Project=UAT-B5, kind=Project, person=Jordan Hale, today's date gives exactly 2 rows (project.update, project.create), grouped under "Sunday, 18 Oct 2026 / 2 changes"; a future date range shows "Nothing matches these filters". Only 20 rows exist so the 50-per-page limit was not exercised (only about 20 rows exist). | 3-11-desktop.png |
| 3-12 | PASS | Budget > Forecast and trend (Customer Data Platform): entered to-finish 500000 then 600000 and method "Bottom-up", saved (PATCH 200, toast "Forecast saved."). Card shows both "EAC by cost performance" (1,325,161.29) and "EAC bottom-up" (3,001,600 = 821,600 + 1,580,000 + 600,000); EVM table row names the method ("bottom-up" beside EAC). Card figures refresh a few seconds after save, not instantly. This changed seed project CDP-CORE's saved forecast settings. | 3-12-desktop.png |
| 3-13 | PASS | Forecast card at 390px: input, input, method select and Save button stack full width (324px, 44px high, no overlap), figures above; scrollWidth 390. Cosmetic: the selected method text is clipped in the select ("Bottom-up (spent + committed + to fi"). | 3-13-phone.png |
| 3-14 | PASS | Budget (desktop): "Suggested RAG: red (15 days past plan; SPI 0.93)" beside "Declared RAG amber", with the line "Early read from 1 snapshot. Advice only; the declared RAG is yours to set." Declared RAG still amber via the API afterwards. | 3-14-desktop.png |
| 3-15 | PASS (partial) | Approvals has Pending/Decided and All 1 / Mine 0 buttons. Mine (URL ?scope=mine) shows "Nothing is assigned to you. Switch to All to see every pending request." and GET /api/review?mine=1 returns an empty list. A non-empty Mine could not be checked: nothing can be assigned to the admin (no second human login, no token minting, and a request cannot be assigned to its own requester). Note the Approvals page lists only the 1 deletion request, while the Review Queue lists 16 items (5 change requests); the weekly report says "5 pending approvals". | 3-15-mine-desktop.png |
| 3-16 | PASS | Project dependencies panel on UAT-B5: Add dependency (project UAT-B7, kind Delivery, note) gave 201 and listed under "Depends on" with kind, health and note; on UAT-B7 the same row shows under "Needed by". Remove took the row away (panel then reads "No project dependencies declared."). The panel refreshes a few seconds after the click, so it looks unchanged at first. | 3-16-desktop.png |
| 3-17 | PASS | From UAT-B7 added a dependency on UAT-B5 (which already depends on B7): refused 422 code circular_dependency, toast and inline text "Adding this dependency would create a circular reference". | 3-17-desktop.png |
| 3-18 | PASS | UAT-B5 (green) depends on UAT-B6 (red): Portfolio shows an amber CONTINGENT tag beside UAT-B5; its tooltip (title text) reads "Contingent on UAT-B6 UAT-B6 test project, which is delayed. This project's own health is unchanged."; the green dot and bar stay green. Cosmetic: the tag squeezes the project name to "UAT-...". Hover tooltip is a native title, not visible in the screenshot. | 3-18-desktop.png |
| 4-1 | PASS | Approval policy card (phone) has rows for Routine, Normal, High risk, Emergency, Strategic each with who decides; turnaround hours on four of them (Emergency shows who approves afterwards and uses the retro window below instead); auto-approve checkbox (unchecked) with "Off by default. Applies to routine requests only..." hint, schedule threshold, cost threshold, currency, emergency window. Fields stack (x 37-353 of 390), scrollWidth 390. LOCATION: the card is on Integrations, not Settings as the plan and owner-visible list say. | 4-1-top-phone.png |
| 4-2 | PASS | Cost threshold set to 20000 and saved ("Approval policy saved."); after reload the field shows 20000. Audit log gained exactly one row, workspace.settings_update, with before and after values (46 to 47 rows). | 4-2-desktop.png |
| 4-3 | FAIL | Raised CR-010 (cost 10000, no tier control on the form) through the UI. API returns tier normal and approval_deadline_at 2 days out, but the change detail panel shows no Normal tier and no deadline (the badge is hidden for normal and no deadline line exists); neither /review nor Approvals shows it either. | 4-3-desktop.png |
| 4-4 | PASS | CR-011 cost 60000 (threshold 20000) shows a "High risk" badge in the detail panel; API tier high_risk, deadline 3 days out (not shown in the UI, see 4-3). | 4-4-desktop.png |
| 4-5 | PASS | Tier select does not exist on the form (see defect), so tested through the API: tier routine with impact_cost 1000 returns 422 with field "tier": "A routine change cannot carry a cost, a schedule impact or a scope impact. Raise it as normal." Routine with no cost saves (CR-012, deadline 1 day out). | - |
| 4-6 | BLOCKED | Needs a manager login. The one-click demo login is admin only, the demo account cannot mint tokens (403 demo_restricted) and no manager password is known. Not run. (Self-approval check: admin approving own CR-011 is refused 403 "Self-approval is not allowed (four-eyes)".) | - |
| 4-7 | BLOCKED | The only admin raised CR-011 himself (the same demo user is requester and admin), so four-eyes refuses the approval (403 self_approval; the panel says "You raised this ... a different person must decide"). No second person available to raise the request or to approve it. | - |
| 4-8 | PASS | No Emergency tick box exists on the raise form (defect logged), so raised through the API with is_emergency true. CR-013 shows status Emergency, tier emergency, retro deadline 20 Oct 2026 (about 48 h), approval_deadline_at null. Panel text: "Emergency change. It can go live now; an admin gives the approval by 20 Oct 2026." | 4-8-desktop.png |
| 4-9 | PASS | Pressed "Mark implemented" on CR-013 (POST implement 200). Status becomes Implemented, "Implemented on 18 Oct 2026 by Jordan Hale", and the emergency note with the retro date ("an admin gives the approval by 20 Oct 2026") stays. | 4-9-desktop.png |
| 4-10 | BLOCKED | Same four-eyes reason as 4-7: the admin who raised emergency CR-013 is refused a retro decision (403 self_approval) and the panel shows no decision button. Needs a second admin. | - |
| 4-11 | BLOCKED | No emergency with a past retro deadline exists and one cannot be aged through the UI or API (the retro window is 48 h; the setting minimum was not tried to avoid changing the workspace policy). Developer set-up needed, as the plan says. | - |
| 4-12 | BLOCKED | Auto-approve checkbox checked as OFF (4-1). A routine change past its deadline cannot be produced (CR-012 routine deadline is 24 h away). Daily tick after CR-012: autoApproved 0, retroOverdue 0, escalated 0, which is only consistent with not-yet-due. | - |
| 4-13 | FAIL | No "Request deletion" button on the risk (detail shows History and Edit only). Sent DELETE /api/risks/<id> with a reason instead: 202, deletion request pending, risk stays in the register. But the risk panel shows no "Deletion requested" note. | 4-13-desktop.png |
| 4-14 | BLOCKED | Needs a different manager. As the only available identity, approving the risk deletion I raised is refused (403 self_approval). What a reviewer can see: Approvals lists the request with kind Risk, risk title, project, reason and "decide by 20 Oct 2026", and the panel says "You raised this ... a different person must decide". No "what approving removes" line for a risk. | 4-14-desktop.png |
| 4-15 | PASS | Milestone panel (Project > Activity tab) has Request deletion; dialog at 390px stacks (scrollWidth 390) and says tasks stay but are unlinked. Submitting (DELETE 202) shows toast "Deletion requested..." and a "Deletion requested" badge on the milestone. Approvals row says "Approving also detaches: 3 tasks (kept, no longer under this milestone)". Wording differs from "removes N tasks" (more accurate). | 4-15-desktop.png, 4-15b-dialog-phone.png |
| 4-16 | BLOCKED | Needs a different person to approve. The admin raised the milestone request, so approval is refused by four-eyes. Not attempted beyond that. | - |
| 4-17 | PASS | Trust Center chain line read "Chain not checked yet" with Verify now. After Verify now: "Chain verified, 69 rows, last check 2026-10-18 09:10 UTC". Audit log gained one audit.verified row (chain_seq 70, row_hash present). | 4-17-desktop.png |
| 4-18 | BLOCKED | Needs a member login; none available (admin-only demo login, no token minting). Source check not made. | - |
| 4-19 | PASS | Integrations > GitHub: Connect GitHub (POST connector 201) shows "WEBHOOK SECRET (SHOWN ONCE)" with Copy and "I have copied it", status Active, WEBHOOK ADDRESS (payload URL) http://localhost:3000/api/integrations/github/<id>/events, setup instructions, Pause / Rotate secret / Revoke, four status selects, Latest events. (Secret not stored by me; I rotated it later for 4-23.) | 4-19-desktop.png |
| 4-20 | PASS | GitHub card at 390px: the four status selects stack at 316px wide (x 37 to 353), 44px high, 78px apart, no overlap, scrollWidth 390. The events list was empty at this point (no deliveries yet), re-checked below after deliveries. | 4-20-phone.png |
| 4-21 | FAIL | Task detail has a "Pull request to link" field and a Link PR button. Bad values ("not a pr", "#0") keep the button disabled with the hint "owner/repo#42 or the pull request address"; mixed-case "UAT-B/Probe#7" is accepted (stored lower-cased as github:uat-b/probe#7). Save gives toast "Pull request linked." and the API stores external_ref github:uat-b/probe#7. But the panel does not show the stored reference afterwards, and reopening the task shows the field empty. | 4-21-desktop.png |
| 4-22 | BLOCKED | No GitHub repository is available, so adding the webhook and reading GitHub's "Recent deliveries" green tick could not be done. Substitute: signed deliveries sent from a script to the webhook address: ping returned 200 {"ok":true}; a delivery with a wrong signature returned 401. | - |
| 4-23 | PASS (with defects) | Signed PR-opened then PR-merged deliveries for the linked task (uat-b/probe#7): GitHub card lists "PR opened ... Applied, Now In progress" and "PR merged ... Applied, Now In review". Task type became started, then label In review. Defects: after open the task label stays "Backlog" (type started); a Deploy succeeded delivery shows "Not applied, Could not be applied" (work event reason error), the task is not completed. | 4-23-desktop.png |
| 4-24 | PASS | Locked UAT-B3 through the UI (Lock baseline, POST lock 200), linked task uat-b/probe#8; a signed PR-opened delivery answered 200, the task stayed backlog, and the GitHub card lists "PR opened uat-b/probe#8 ... Not applied, Skipped: project is locked". | 4-24-desktop.png |
| 4-25 | PASS | Pause on the GitHub card: toast "GitHub events paused.", card shows Paused with a Resume button. A correctly signed delivery returned 401 {"error":"unauthorized"} (GitHub would show a failed delivery). Resumed afterwards (status active). I could not see GitHub's own delivery screen. | 4-25-desktop.png |

## Not run

| Step | Why |
|---|---|
| 3-7 | Nothing is older than the 3-day threshold (seed created today) and records cannot be aged through the UI or API. The daily tick ran twice and nudged 0 items. Needs a member login or backdated data. |
| 4-6, 4-7, 4-10 | Need a manager (refusal) and a second person (approval and retro decision). The admin who raised the change is refused by four-eyes. |
| 4-11, 4-12 | Need an emergency whose retro deadline has passed and a routine change past its deadline. Needs developer set-up of past deadlines. |
| 4-14, 4-16 | Need a different person to approve the deletion requests I raised. |
| 4-18 | Needs a member login. |
| 4-22 | Needs a real GitHub repository. Signed deliveries were sent from a script instead (4-23 to 4-25). |
| Non-empty Mine in 3-15, "assigned to me" cue | Nothing can be assigned to the admin. |
| 3-10 stale-item sample | No stale notification exists. |
| 3-11 "50 per page" | Only about 20 rows exist, so paging was not exercised. |
| 4-11 digest and weekly report overdue line | Not reachable without an overdue emergency. |

## Other observations (not logged as defects)

- The weekly report and the review queue count 5 pending approvals (change requests). The Approvals page lists only the 1 or 2 deletion requests. The Approvals sidebar badge shows 1, the Governance badge 16. This looks deliberate but may confuse a reader.
- "removes N tasks" for a milestone reads "Approving also detaches: 3 tasks (kept, no longer under this milestone)", which is the more accurate text.
- probe-github.mjs ran (its guard allowed it, web/.env.local does not exist): 5 of 8 checks pass, 3 fail (see defect list, GH3 and GH6 are fixture problems, GH4 is a real defect).

## Retest (after fix pass dbead57)

Date 2026-10-18. Same rules as the first pass. This time there were three real identities: the admin (Jordan Hale, normal sign-in), the demo manager (Demo Manager, one-click demo button) and a member (Daniel Okoro). I gave the member a local password through the local auth admin endpoint so the member views could be tested. Screenshots are `shots/retest-*.png`. I also used direct SQL on the local database for test-data setup only (aging records, 3-7, 4-11, 4-12, UAT-009); every assertion was made through the app or its API.

Outcome per UAT ID is in `UAT-log/_intake/retest-b.md`: UAT-001, 002, 003, 004, 005, 006, 007, 009, 010, 011, 012, 022 are fixed. UAT-017 is fixed for the GitHub and Lark probes but API11 still fails for another reason (a replayed decision answers 200, the same behaviour as open UAT-018). New findings are in `UAT-log/_intake/tester-b-new.md`.

### Previously BLOCKED steps

| Step | Result | What I saw | Screenshot |
|---|---|---|---|
| 3-7 | PASS | Audit rows cannot be backdated, so I inserted a task with updated_at 10 days old (assigned to the admin) and ran the daily tick: stalenudged 1, one "Stale task" notification with a link to the task, shown in the bell. A second tick added none. | retest-3-7-desktop.png |
| 3-10 (stale sample) | PASS | Email previews now lists the item.stale notification as "Needs an update: Stale task: ..." | retest-3-10-desktop.png |
| 4-6 | PASS | With two admins, the demo manager sees "This request needs an admin to decide it. Ask an admin to decide." and no decision form on a high-risk change (API 403 "Only admins can approve a high-risk request."). With only one admin the manager may decide it (decision D7 fallback): CR-015 was approved by the manager. | retest-4-6-desktop.png |
| 4-7 | PASS | Admin approved the manager's high-risk CR-014 with a rationale; status approved, decided by the admin. The manager approving their own was refused (four-eyes). | - |
| 4-10 | PASS | Manager raised emergency CR-017 and marked it implemented; the admin recorded the approve retro decision: still Implemented, retro_decided_at and outcome approved set. The manager deciding their own was refused. | - |
| 4-11 | FAIL | CR-013 (retro due set to the past by SQL): the detail panel says "Emergency change, overdue: the approval was due 17 Oct 2026 and is still missing", admins got an "Emergency change overdue for retro approval" notice, and the weekly-report notification text says "1 emergency change is overdue for approval". But there is no red Overdue marker on the Approvals page or in the review queue, the Change Control list row shows only "Implemented", and the weekly report page has no overdue-emergency line. Logged as a new finding. | retest-4-11-desktop.png |
| 4-12 | PASS | Routine CR-012 deadline set to the past: the tick escalated (admin notice "Overdue: Change request CR-012"), the change stays Raised, autoApproved 0, auto-approve still off. The review queue shows "overdue since 2026-10-18". | retest-4-11-desktop.png |
| 4-14 | PASS | Demo manager approved the admin's risk deletion in Approvals (two steps: Approve, then Confirm Approve with an optional note); POST approve 200, the risk left the register. The row shows reason, "decide by" and requester, with no "what approving removes" line for a risk. | retest-4-14-desktop.png |
| 4-16 | PASS | Demo manager approved the milestone deletion (API 200 committed). The milestone is gone and its 3 tasks remain with no milestone. The approver was the manager, not an admin, since the request came from the admin. | retest-4-15-approvals-desktop.png (earlier) |
| 4-18 | PASS | Member opens Trust Center: the audit stream shows, no Verify now button. GET /api/audit/verify as member answers 403; as manager 200. | retest-4-18-desktop.png |
| 4-22 | BLOCKED | Still needs a real GitHub repository. | - |

### Notes on the retest

- Phone (390 px) checks on the changed screens (project edit with backup owner, raise change form, Settings policy card, risk panel with the deletion badge): scrollWidth 390, no console errors.
- A "fixed" UI can still feel stale: Remove dependency, Unlink PR and Save forecast refresh 3 to 6 seconds after the click.
- My retry runs created five extra projects named UAT-B9 (a harness retry, not a product issue). They are harmless test data.
- Dev server: it hot-reload-looped while other runs were active (logged as an environment finding); it settled after the restart.

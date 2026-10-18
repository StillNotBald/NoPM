# 01 — Findings

Status: **OPEN** — cycle 1 (2026-10-18) intake minted below. Source rows are in `_intake/` (tester A, tester B, runner C).

## Purpose

The raw intake sheet for user acceptance testing. Every defect a human reviewer reports during a UAT round gets exactly one row here, the first time it's reported, with a new UAT ID. This sheet does not judge root cause (that's `02-ROOT-CAUSES.md`) and does not track fix/retest status beyond a coarse status column (that detail lives in `03-RETEST-SHEET.md`).

## Owner rule

**No new UAT IDs anywhere else in this folder.** A UAT ID (`UAT-001`, `UAT-002`, ...) is minted here, once, in ID order, the first time a reviewer reports the defect. If the same underlying defect is reported twice by different reviewers, it is one UAT ID with two "Reported by" notes, not two IDs — merge on discovery, don't dedupe later.

## Sheet

Severity here is the reviewer's first-pass call (runner C's "High" is entered as Major, "Low" as Minor). Rows are in severity order, then report order.

| UAT ID | Date | Reported by | Page / journey | What was expected | What happened | Severity | Status |
|---|---|---|---|---|---|---|---|
| UAT-001 | 2026-10-18 | UAT tester B; UAT runner C | Integrations > GitHub: PR merged, then successful deployment event | A successful deployment naming the PR completes the linked task (rule default Completed) and clears the "In review" label | The delivery is recorded "Not applied, Could not be applied" (reason error, no task_id) and the task stays In review. Clearing the label writes NULL into the NOT NULL tasks.status. probe-github check GH4 fails the same way | Major | CLOSED |
| UAT-002 | 2026-10-18 | UAT tester B | Notification bell, phone and desktop, all notification types | Unread notifications (weekly report, stale item) show in the bell with a count badge and link to their page | Bell always reads "You're all caught up" with no badge, while GET /api/notifications returns 2 unread rows. Users have no in-app path to the weekly report or nudges | Major | CLOSED |
| UAT-003 | 2026-10-18 | UAT tester B | Project edit form (phone and desktop), project created with no Program | Saving the edit form (for example setting a backup owner) saves | Toast "Invalid project data", nothing saves. The form sends program:null and the API answers 422 "program: expected string, received null". Only projects created without a program hit it | Major | CLOSED |
| UAT-004 | 2026-10-18 | UAT tester B | Change Control > Raise Change Request form, desktop (UAT 4-5, 4-8) | A tier choice (Routine offered only with no cost) and an Emergency tick box for managers and admins | The form has no tier select, no Emergency tick box and no approver picker. Tier and emergency can only be sent through the API | Major | CLOSED |
| UAT-005 | 2026-10-18 | UAT tester B | Change Control detail, Review queue, Approvals: a waiting change request (UAT 4-3) | Tier (Normal) and the approval deadline are shown on each waiting request | The API returns tier and approval_deadline_at, but no UI surface shows a Normal badge or any deadline | Major | CLOSED |
| UAT-006 | 2026-10-18 | UAT tester B | Risk detail panel, also Issues, Budget expenses, Documents (UAT 4-13) | A "Request deletion" button with a reason dialog | Risk detail shows only History and Edit. Request deletion UI exists for milestones, tasks and projects only. For risks, issues, expenses and documents a request can only be made through the API (DELETE returns 202) | Major | CLOSED |
| UAT-007 | 2026-10-18 | UAT tester B | Task detail panel, Pull request field (UAT 4-21) | After Link PR the reference (owner/repo#number) shows on the task, and can be unlinked | Toast says "Pull request linked." and the API holds the external_ref, but the panel shows no reference and the field is empty when the task is reopened | Major | CLOSED |
| UAT-008 | 2026-10-18 | UAT tester A | Documents, document viewer for an evidence document (OWNER-VISIBLE M4) | The viewer shows evidence type, result, tester, note and linked change request | DOC-020 shows only folder, project, owner, dates and history. No evidence fields appear although the API holds them | Major | CLOSED |
| UAT-009 | 2026-10-18 | UAT tester B | Daily tick / weekly report (step 3-8), decision D2 | The report goes out only on the chosen weekday (Monday); a missed day loses the week unless an admin presses Send now | The daily tick on Sunday 2026-10-18 created the report for the week of 12 Oct and notified admin and manager (catch-up in the same ISO week, the option D2 rejected) | Minor | CLOSED |
| UAT-010 | 2026-10-18 | UAT tester B | Settings / Integrations, Approval policy card (UAT 4-1) | The card is found under Settings | Settings has no Approval policy card. It sits at the bottom of Integrations, below Nudges and weekly report | Minor | CLOSED |
| UAT-011 | 2026-10-18 | UAT tester B | Risk detail panel after a deletion request (UAT 4-13) | A "Deletion requested" note while the request waits | R-009 had a pending deletion request (202) but its panel shows no note and looks unchanged | Minor | CLOSED |
| UAT-012 | 2026-10-18 | UAT tester B | Task status after a PR-opened event | Task moves to In progress (event list says "Now In progress") | Status type becomes started but the label stays "Backlog", so board and panel still show Backlog | Minor | CLOSED |
| UAT-013 | 2026-10-18 | UAT tester A | Audit pack, date range | A range where from is after to is refused with a message | The API returns 200 and a pack for from=2026-10-31 and to=2026-10-01 | Minor | CLOSED |
| UAT-014 | 2026-10-18 | UAT tester A | Project page header, desktop 1280 px (step 1A-1) | Lock and backup badges sit beside the title without overlap | With the lock and "No backup owner" badges the title is squeezed into a narrow column and breaks across four lines. The "On track" badge overlaps the word "Global". Phone width is fine | Minor | CLOSED |
| UAT-015 | 2026-10-18 | UAT tester A | Documents, New Document form (OWNER-VISIBLE M4) | The form has an Evidence section | No change request field and no evidence section. Evidence can only be added from the Change Control detail panel | Minor | CLOSED |
| UAT-016 | 2026-10-18 | UAT runner C | Playwright suite (dialogs, f2a, f2b, project-detail, writes specs) | Specs pass against the current build | Several specs fail on stale locators: collapsed details on /tokens, duplicate Priority header match, /sprints hidden in Essentials sidebar mode, tabs now role=tab. No product defect behind them | Minor | CLOSED |
| UAT-017 | 2026-10-18 | UAT tester B; UAT runner C | Local probes: probe-github GH3/GH6, probe-api API11, probe-lark LK-X1 | Probes pass against the current build | GH3 (null status) and GH6 (projects_lock_integrity) use SQL the new constraints reject. API11 and LK-X1 omit expected_updated_at, which the API now requires (422 version_required) | Minor | CLOSED |
| UAT-018 | 2026-10-18 | UAT runner C | Change request: replayed approval through a PAT (probe API8) | A second approve on an already decided request is refused (probe expects 422) | The replay answers 200 {"data":{"committed":true}}. May be intended idempotency; probe and docs disagree | Minor | REOPENED |
| UAT-019 | 2026-10-18 | UAT tester A | Risk create form (step 1C-4), plan wording | Plan: no Category field and no risk categories shown | The form has a "Risk category" dropdown with eight fixed values. OWNER-VISIBLE says only the free-text Category is removed. The plan's "safety" impact area does not exist | Minor | CLOSED |
| UAT-020 | 2026-10-18 | UAT tester A | Export steps 1E and 1F, plan wording | Members export at Settings -> Members as "Export members (CSV)"; addresses /api/export/members and /api/export/tokens; audit button "Export audit (CSV)" | Buttons are on the People page and read "Export people (CSV)". Both plan addresses return 404; the real one is /api/export?entity=members. The Trust Center button reads "Export CSV" | Minor | CLOSED |
| UAT-021 | 2026-10-18 | UAT tester A | UAT plan, Wave 2 | The Wave 2 table lists test steps | The table is empty, so there are no steps to run | Minor | CLOSED |
| UAT-022 | 2026-10-18 | UAT tester B | Project edit form, same-person backup refusal | A plain-language message that the backup must be a different person from the owner | Message shows raw field names "backup_owner_id must be a different person from owner_id" | Cosmetic | CLOSED |
| UAT-023 | 2026-10-18 | UAT tester A | Change Control list, desktop 1280 px | The Impact column reflects the impact entered | A request with Impact by area set shows a dash in the Impact column | Cosmetic | CLOSED |
| UAT-024 | 2026-10-18 | UAT tester A | Change Control list, desktop 1280 px | Titles are readable and all columns fit | Titles are cut after about 12 characters (for example "Programme-level:...") and the last column is cut off at the right | Cosmetic | CLOSED |
| UAT-025 | 2026-10-18 | UAT tester A | Raise Change Request form, Impact by area | Note field placeholder is readable | The placeholder reads "Note (optiona", clipped | Cosmetic | CLOSED |
| UAT-026 | 2026-10-18 | UAT tester A | Document, decision and evidence forms, phone | The "+ Add summary" and "+ Add body content" links are separate | They run together as "+ Add summary+ Add body content" with no space | Cosmetic | CLOSED |
| UAT-027 | 2026-10-18 | UAT tester A | Change Control status chips, phone 390 px | All status chips are visible | Implemented, Rejected, Deferred and All are off screen until the chip row is scrolled sideways | Cosmetic | CLOSED |
| UAT-028 | 2026-10-18 | UAT tester A | Risks API, view=full | Only the new impact_areas field is returned | Both the old impact_area and the new impact_areas are returned. Not a break, a leftover | Cosmetic | CLOSED |
| UAT-029 | 2026-10-18 | UAT tester A | Documents, evidence document viewer (step 2-6a) | The linked change request is named by its reference and title, for example CR-009 | The viewer shows "Evidence for change request: Change Control", which is the folder name, not the request | minor | OPEN |
| UAT-030 | 2026-10-18 | UAT tester A | Member export of tokens, GET /api/export?entity=tokens (step 1F-3) | The refusal names the permission needed for a tokens export (admin only) | The 403 says "Listing people requires an admin or manager session", the message for the people export | minor | OPEN |
| UAT-031 | 2026-10-18 | UAT tester A | Member sidebar and /api/review | A member, who cannot decide anything, sees no count of items "awaiting your decision" | The member sees a badge "28 items awaiting your decision" next to Governance, and GET /api/review returns the full queue. May be intended visibility, so the badge wording may be the issue | minor | OPEN |
| UAT-032 | 2026-10-18 | UAT tester A | Project page for a member, step 1A-4 | The step says try Unlock and expect a refusal naming who can unlock | A member sees no Unlock button, so the refusal text is only reachable through the API. The step cannot be done as written | cosmetic | OPEN |
| UAT-033 | 2026-10-18 | UAT tester B | Project edit form (phone and desktop), project with no start date | Saving the edit form saves, whatever optional fields are empty (same class as UAT-003) | Project created without a start date: Save Changes answers 422 "start_date: Invalid input: expected string, received null" and nothing saves. program null is now accepted, start_date null is not | major | OPEN |
| UAT-034 | 2026-10-18 | UAT tester B | Review queue, Approvals, Change Control list, weekly report page (step 4-11) | An emergency change whose retro decision is overdue carries a red Overdue marker in the Approvals queue and is named in the digest and the weekly report | Only the change detail panel says "Emergency change, overdue" and an admin notification arrives. CR-013 does not appear on /approvals (deletion requests only) or on /review (although GET /api/review marks it retro_overdue true), the Change Control list row shows only "Implemented", and the weekly report page has no overdue-emergency line (only the notification body says "1 emergency change is overdue for approval") | minor | OPEN |

### Column notes

- **UAT ID** — sequential, never reused, never renumbered even if a finding is later judged not-a-bug (mark it `WONT-FIX` with a reason instead of deleting the row).
- **Severity** — reviewer's first-pass judgment (Blocker / Major / Minor / Cosmetic); triage in `02-ROOT-CAUSES.md` may reclassify it, and if so that sheet records the reclassification — this sheet keeps the original call as reported.
- **Status** — see the legend in `UAT-log/README.md`. This sheet only ever sets a row to OPEN (new) or WONT-FIX (owner call, reason inline in a note); every other status transition is driven by the other two sheets and reflected back here.

## Not defects (no UAT IDs)

Dropped from the intake because the cause is the test setup, not the product. Listed so the next round's setup avoids them.

| Source | Item | Why it is not a product defect |
|---|---|---|
| Tester A | Token mint refused: "Not available in the shared demo" (page and API) | DEMO_EMAIL was set to the admin account, so the admin is the demo identity and demo_restricted applies. Re-run with a distinct demo user. Also blocked the token, invite and second-identity steps |
| Tester A | Only the admin login works; manager and member seed passwords are random | Test environment has a single usable identity. Role steps need seeded known passwords |
| Tester A | Session fell back to sign-in several times | Dev-server and shared-demo session behaviour. Re-login fixed it each time |
| Tester A | First visits show a grey skeleton and avatar "U" for 5 to 10 seconds | Next dev server compiles on demand |
| Tester A | Next dev badge covers Cancel on phone forms; Risks page hydration warning from the test browser's caret-color style | Dev only. The dev overlay and dev-server CSP do not exist in a production build |
| Runner C | probe-lark LK-EM0 plus 16 dependent checks fail | App was not started with the fake-lark override. Note for next round: the dead-port proxy guard was also absent, so the connector test reached a real Lark host with a fake credential (no tenant data) |
| Runner C | Playwright invite lifecycle and saved-view four corners return 403 demo_restricted | Same DEMO_EMAIL setup as above |
| Runner C | Playwright register-filter-builder URL assertion fails | Selecting before hydration on the dev server; works by hand |

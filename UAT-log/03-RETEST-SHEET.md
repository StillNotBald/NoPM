# 03 — Retest Sheet

Status: **ACTIVE** — cycle 1 retest recorded 2026-10-18.

## Purpose

The closure sheet. For each UAT ID that has a fix shipped against its `02-ROOT-CAUSES.md` entry, this sheet records the retest attempt and its outcome — confirming the fix actually closes the finding, in the same environment class the original defect was found in (live/authed, not just unit-test green).

## Owner rules

- **No new UAT IDs are minted here.** Every row references a UAT ID from `01-FINDINGS.md`. A retest that surfaces a *different* defect than the one being retested is a fresh `01-FINDINGS.md` row with its own new ID — never folded into this sheet's row for the original ID.
- **Nothing in this folder — including this sheet — asserts pass/fail counts.** This sheet records one retest outcome per row (Confirmed-fixed / Still-broken / Regressed-elsewhere). It does not roll those up into an "N of M passed" summary; that kind of aggregate belongs in `testing-log/`, sourced from an actual suite run, not from this sheet's row count.
- **A failed retest reopens the same ID.** If a retest fails, the row here records `REOPENED` and a new row is appended for the next retest attempt against that same UAT ID — the ID itself is never incremented or duplicated for a re-fix cycle.

## Sheet

| UAT ID | Retest date | Retested by | Method (page path / API call / script) | Outcome | Status |
|---|---|---|---|---|---|
| UAT-008 | 2026-10-18 | UAT tester A | /documents, open DOC-020, read the viewer | fixed — Viewer shows evidence type, result, tested by, tested on, note. The change request is labelled "Change Control" instead of CR-009 (new row in tester-a-new). shots/retest-UAT-008-desktop.png | CLOSED |
| UAT-013 | 2026-10-18 | UAT tester A | Admin session GET /api/export?entity=audit_pack&from=2026-10-31&to=2026-10-01 | fixed — 422 "from must not be after to". A valid range still returns 200 | CLOSED |
| UAT-014 | 2026-10-18 | UAT tester A | /projects/055da553-9359-45e7-8606-cdc3ece166f7 at 1280 px | fixed — Title is on one line, badges do not overlap. shots/retest-UAT-014-desktop.png | CLOSED |
| UAT-015 | 2026-10-18 | UAT tester A | /documents, New Document, pick CR-009 in the change request field | fixed — Field "Attach as evidence for a change request (optional)" shows, and an Evidence section appears once a request is chosen. shots/retest-UAT-015-desktop.png | CLOSED |
| UAT-019 | 2026-10-18 | UAT tester A | Read UAT-PLAN.md step 1C-4 | fixed — Plan now says the free-text Category is gone and a Risk category dropdown is correct. The "safety" example is gone | CLOSED |
| UAT-020 | 2026-10-18 | UAT tester A | Read UAT-PLAN.md steps 1E, 1F, 1G, then GET /api/export/tokens | still present — 1E-1, 1E-3 and 1G-1 are corrected. Step 1F-3 still says /api/export/tokens, which returns 404. The real address is /api/export?entity=tokens | REOPENED |
| UAT-021 | 2026-10-18 | UAT tester A | Read UAT-PLAN.md Wave 2 table and ran 2-1 to 2-10 | fixed — The table now lists steps 2-1, 2-2, 2-3, 2-4, 2-5, 2-6a, 2-6b, 2-6c, 2-7, 2-8, 2-9 and 2-10. All ran | CLOSED |
| UAT-023 | 2026-10-18 | UAT tester A | /change-control, row CR-009 and CR-023 Impact column | fixed — Shows "Schedule down, Cost up". shots/retest-UAT-024-desktop.png | CLOSED |
| UAT-024 | 2026-10-18 | UAT tester A | /change-control at 1280 px | fixed — Titles wrap on two lines, all columns including Requested by are visible, table fits its container. shots/retest-UAT-024-desktop.png | CLOSED |
| UAT-025 | 2026-10-18 | UAT tester A | /change-control, Raise Change Request at 390 px, Impact by area | fixed — Placeholder reads "Note", full width, not clipped. shots/retest-UAT-025-phone.png | CLOSED |
| UAT-026 | 2026-10-18 | UAT tester A | /documents, New Document at 1280 px, the two disclosure buttons | fixed — "+ Add summary" and "+ Add body content" are 16 px apart. Decision form not re-checked on a phone. shots/retest-UAT-015-desktop.png | CLOSED |
| UAT-027 | 2026-10-18 | UAT tester A | /change-control at 390 px | fixed — The seven chips wrap onto three rows and all are visible. shots/retest-UAT-027-phone.png | CLOSED |
| UAT-028 | 2026-10-18 | UAT tester A | Token GET /api/projects/<id>/risks?view=full | fixed — Keys include impact_areas, no impact_area, no category | CLOSED |
| UAT-001 | 2026-10-18 | UAT tester B | API with a signed delivery sequence on a new linked task (UAT-B retest PR task) | fixed — PR opened gave In progress / started, PR merged In review, deployment success Done / completed. The GitHub card events read applied, Completed. The task is completed and no error is recorded. | CLOSED |
| UAT-002 | 2026-10-18 | UAT tester B | Phone 390 px, admin session: bell with 13 unread rows in the API | fixed — Bell label reads 'Notifications, 13 unread' and the popover lists the notifications (deletion approved, emergency change, CR approved, overdue retro) with Mark all read. Before the fix it read 'all caught up'. | CLOSED |
| UAT-003 | 2026-10-18 | UAT tester B | Phone 390 px, admin: created UAT-B10 (no program, with dates), Edit, set backup owner Priya, Save | fixed — Saved (API backup_owner_id = Priya). The form now sends program null and the API accepts it. NOTE: a project with no start date (UAT-B9) still fails with "Invalid input: expected string, received null" for start_date; logged as a new defect. | CLOSED |
| UAT-004 | 2026-10-18 | UAT tester B | Desktop, admin: Raise Change Request form, then raised CR with tier choices, emergency tick | fixed — Form now has Approval tier (Automatic, Routine, Normal, High risk, Strategic), an Approver picker (Priya Nair, Demo Manager) and an "Emergency: ship now, approve afterwards" tick. Routine is disabled once a cost is entered (hint "only with no cost, schedule or scope impact"). Ticking Emergency disables the tier select and raised CR-022 with status Emergency and a retro date 2 days out. | CLOSED |
| UAT-005 | 2026-10-18 | UAT tester B | Desktop, admin: opened CR-020 (cost 10000) and CR-021 (cost 60000) in Change Control | fixed — Detail shows a Normal badge and "DECISION DUE 20 Oct 2026" for CR-020, High risk and "DECISION DUE 21 Oct 2026" for CR-021. Not re-checked in the Review queue. | CLOSED |
| UAT-006 | 2026-10-18 | UAT tester B | Desktop, admin: opened risk R-011 in the Risks register, pressed Request deletion, gave a reason | fixed — Risk panel now has Request deletion with a reason dialog; submitting gives "Deletion requested. A different person must approve it before the risk is removed." Request deletion buttons also exist on the document viewer and the Budget expense ledger (12 on the budget page). The issue panel was not reached in the UI (new issue not found in the /issues list), the button is mounted in issue-detail by source. | CLOSED |
| UAT-007 | 2026-10-18 | UAT tester B | Desktop, admin: task UAT-B task 1 (linked uat-b/probe#7), detail panel | fixed — Panel now shows "Pull request uat-b/probe#7" with an Unlink button. Unlink sent PATCH 200 (external_ref and source null); the row stayed visible for a few seconds after unlink before refreshing. | CLOSED |
| UAT-009 | 2026-10-18 | UAT tester B | SQL test-data setup (deleted this workspace's stored weekly report), then the daily tick on Sunday 2026-10-18 with report day Monday; then report day set to Sunday and the tick again; day restored to Monday | fixed — Report day Monday on a Sunday: weeklyReports 0, no report stored. Report day Sunday: weeklyReports 1, report stored. The week is no longer sent on a later day. | CLOSED |
| UAT-010 | 2026-10-18 | UAT tester B | Desktop, admin: /settings and /integrations | fixed — The Approval policy card is on Settings (also seen at 390 px) and no longer on Integrations. | CLOSED |
| UAT-011 | 2026-10-18 | UAT tester B | Same risk after the request | fixed — Risk panel shows a "Deletion requested" badge beside the title. | CLOSED |
| UAT-012 | 2026-10-18 | UAT tester B | Same delivery sequence | fixed — After PR opened the task label reads In progress (type started); before the fix it stayed Backlog. | CLOSED |
| UAT-017 | 2026-10-18 | UAT tester B | probe-github.mjs, probe-api.mjs and probe-lark.mjs run from web/ with the local stack env | still present (API11 only; GH3, GH6, LK-X1 fixed) — probe-github 8 of 8 PASS (GH3, GH4, GH6 now pass); probe-lark LK-X1 PASS. probe-api: API11 no longer fails on version_required but now fails because a replayed decision answers 200, expected 422 (same behaviour as UAT-018, still OPEN, API8 fails likewise). 13 of 15 pass. | REOPENED |
| UAT-022 | 2026-10-18 | UAT tester B | Same project, chose the owner as backup, Save | fixed — Toast reads "The backup owner must be a different person from the owner." (no raw field names). | CLOSED |
| UAT-018 | 2026-10-18 | UAT tester B | Not in my scope; seen again in probe-api API8 and API11 | still present — A replayed approve or decision answers 200 where the probe expects 422. No change from the original report. | REOPENED |
| UAT-016 | 2026-10-18 | UAT runner C | Full Playwright suite against localhost:3000 (sign-out spec left opt-in), then the opt-in write journeys with E2E_WRITES=1. | Pass — Full suite 77 passed, 0 failed, 12 skipped (opt-in). Write journeys 13 passed, 0 failed, 1 skipped; token mint, invite and second-identity saved views now pass with demo@example.com as the demo user. Two extra stale-test causes found and fixed: nav mode and column choice persist per account, and PAT revoke now asks for confirmation. | CLOSED |
| UAT-017 | 2026-10-18 | UAT runner C | Reran probe-github, probe-lark and probe-api against the local stack and fake-lark. | Pass, with one carve-out — probe-github 8/8 (GH3, GH4, GH6 pass). probe-lark 51/51 (LK-X1 and the 16 LK-EM checks pass; LK-EM7 needed the same version fixture). probe-api 13/15: API8 and API11 fail only on the replayed-decision step (wanted 422, got 200), which is owner decision UAT-018, not test debt. | CLOSED |
| UAT-020 | 2026-10-18 | lead (AI session) | Read UAT-PLAN.md step 1F-3 after correcting the address to /api/export?entity=tokens; tester A confirmed that address returns the CSV for an admin | fixed | CLOSED |

### Column notes

- **Method** — must be concrete enough to re-run (a URL path, an exact `curl`/API call, or a named script from `testing-log/README.md`'s index) — not "checked manually."
- **Outcome** — Confirmed-fixed / Still-broken / Regressed-elsewhere (name the new symptom + file a fresh `01-FINDINGS.md` row for it).
- **Status** — CLOSED on Confirmed-fixed; REOPENED on Still-broken/Regressed-elsewhere.

| UAT-029 | 2026-10-18 | UAT tester A (cycle 2, R2) | /documents, open an evidence document linked to a change request | Confirmed-fixed — viewer names the request by reference and title (testing-log/2026-10-18_uat-cycle-2/tester-a.md R2) | CLOSED |
| UAT-030 | 2026-10-18 | UAT tester A (cycle 2, R3) | Member session GET /api/export?entity=tokens | Confirmed-fixed — 403 "Exporting tokens requires an admin or manager session" (admin or manager, matching GET /api/tokens) | CLOSED |
| UAT-031 | 2026-10-18 | UAT tester A (R4); retest runner (T11) | Sidebar and bottom bar badge as member, manager, admin | Confirmed-fixed — member reads "N items in review", approvers read "awaiting your decision"; both roles load the label after the role resolves | CLOSED |
| UAT-032 | 2026-10-18 | UAT tester A (cycle 2, R5) | Member on a locked project, then POST /api/projects/<id>/unlock | Confirmed-fixed — no Unlock control for a member; API answers 403 naming who can unlock; plan step 1A-4 rewritten | CLOSED |
| UAT-033 | 2026-10-18 | UAT tester A (R1); retest runner (T10) | Edit a project with no start date, Save; clear the Code box, Save | Confirmed-fixed — saves with no 422 for empty dates and empty code (C2-15) | CLOSED |
| UAT-034 | 2026-10-18 | lead | n/a | Superseded — owner decision Q1 retired the retro step and its overdue marker; the emergency flag replaces it (retest T3, T12 confirm the flag in list, detail, weekly report) | SUPERSEDED |

| UAT-035 | 2026-10-18 | retest runner 2 | New Project with name only and with start date only (UI, 390 + 1280); POST /api/projects with target_date null and omitted | Confirmed-fixed — 201 in all runs, project opens, no milestone error (retest2/retest2.md) | CLOSED |
| UAT-036 | 2026-10-18 | retest runner 2 | /approvals and /review as admin with a pending high-risk expense deletion | Confirmed-fixed — badges read High risk / Normal, Emergency stays red | CLOSED |
| UAT-037 | 2026-10-18 | retest runner 2 | CR-028..030 detail pages and GET /api/change-requests/<id> | Confirmed-fixed — no "owner decision" or "Q1" in page text or JSON | CLOSED |
| UAT-038 | 2026-10-18 | retest runner 2 | Settings → Approval policy, High risk description | Confirmed-fixed — names expense deletions at or above the threshold | CLOSED |
| UAT-039 | 2026-10-18 | retest runner 2 | Integrations → GitHub card intro | Confirmed-fixed — "A deployment never completes a task; only a person marks it Completed." | CLOSED |

## Log

- 2026-10-18 cycle 2: UAT-029..033 retested by tester A and the retest runner (reports in `testing-log/2026-10-18_uat-cycle-2/`); UAT-034 superseded by owner decision Q1.

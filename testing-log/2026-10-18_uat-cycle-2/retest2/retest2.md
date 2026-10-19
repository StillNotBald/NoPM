# UAT cycle 2 retest 2 (UAT-035..039)

Environment: 2026-10-18 about 23:00-23:20 MYT, local stack at http://localhost:3000, ledger includes 20261018000106_tier_decisions.sql (applied locally). One headless Chromium at a time, 390x844 then 1280x800. Sessions: demo@example.com (manager), admin@example.com (admin). Screens in `screens/`.

| UAT ID | Method | Outcome | Evidence |
|---|---|---|---|
| UAT-035 | UI as manager: New Project, name only, then name + start date only, at both viewports. POST /api/projects with target_date null and with the field omitted. | Confirmed-fixed | UI: POST 201 all four runs, no error toast, project page opened, 3 milestones scaffolded, DB dates null/null and 2026-11-02/null. API: 201 for null and for omitted. Screens `035-390-*`, `035-1280-*`. |
| UAT-036 | UI as admin: Approvals and Review queue at both viewports. Created a pending high-risk expense deletion (264,000 expense) as manager via DELETE /api/expenses/<id> (202). | Confirmed-fixed | Approvals shows "High risk" and "Normal" badges; Review queue shows Normal / High risk / Routine. No `high_risk` or underscore value anywhere. (Lowercase "routine", "normal", "emergency" in page text are request titles.) Screens `036-*`. |
| UAT-037 | UI as manager: CR-028, CR-029, CR-030 detail at both viewports. GET /api/change-requests/<id> for the three. | Confirmed-fixed | No "owner decision" and no "Q1" in page text or JSON. `decision_rationale` = "Emergency: committed on raise, no approval required." Screens `037-*`. |
| UAT-038 | UI as admin: Settings, Approval policy, both viewports. | Confirmed-fixed | High risk reads "Large cost, deleting a whole project, or deleting an expense at or above the threshold." Screens `038-*`. |
| UAT-039 | UI as admin: Integrations, GitHub card intro, both viewports. | Confirmed-fixed | Intro: "A deployment never completes a task; only a person marks it Completed." Old wording absent. Screens `039-*`. |

## Defects

None new, none still broken.

Notes (not product defects):
- A second, unrelated automated step rewrote the absolute path in `retest/h.mjs` to a `<repo>` placeholder mid-session, which broke the helper. The copy in `retest2/h.mjs` was repaired locally. `retest/h.mjs` was left as found.
- The pending Approvals list has dozens of probe rows in other workspaces; only the demo workspace rows show for admin (that is correct scoping).
- Test data created: 2 projects via API, 4 via UI (names start "UAT035"), 1 pending high-risk expense deletion request.

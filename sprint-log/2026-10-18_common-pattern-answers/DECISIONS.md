# Owner decisions — 2026-10-18 common-pattern answers

Decisions the owner made on 2026-10-18 on the open questions of the journey map (`journeys/OPEN-QUESTIONS.md`). Decisions 1 to 18 are recorded in earlier sprints (see [`../2026-10-17_post-live-followups/DECISIONS.md`](../2026-10-17_post-live-followups/DECISIONS.md)); 7, 8, 9, 10, 11, 16 and 18 stay in force. The seven owner-choice items below were each answered with the recommendation.

| # | Decision | Owner choice | Consequence | Where recorded |
|---|---|---|---|---|
| 19 | Overspend (Q-WRK-7) | Warn at 90% of plan, over at 100%; never block. The percentage is settable per project. | Budget GET returns `overspend { level, warn_pct, over_pct, events[] }`; one `budget.overspend` audit row per level change. Migration 0078. | ADR 0015; R-121; `journeys/COMMON-PATTERN-ANSWERS.md` section 2 item 1 |
| 20 | Deleting a whole project (Q-GOV-12) | Approver sees counts; refuse deletion while approved change requests or approved/applied rebaselines exist; remove stored files after commit. | 422 `project_has_approved_records` at request time and in the commit RPC (P0022). Migration 0076. | ADR 0015; R-120; section 2 item 3 |
| 21 | Access token life (Q-ACC-4) | Default 90 days, maximum 365, warn before expiry. | New tokens expire in 90 days unless `expires_at` is given; `days_left` and `expiring_soon` in the list. Existing tokens untouched. | ADR 0015; R-124; section 2 item 6 |
| 22 | Two-step for admins and managers (Q-ACC-6) | Required, with a 14-day grace period. | `profiles.mfa_grace_started_at` (migration 0081); console redirect to `/settings?mfa=required` after grace; tokens unaffected; demo exempt. The grace starts at release. | ADR 0015; R-124; section 2 item 7 |
| 23 | Money records (Q-WRK-12, Q-WRK-13) | Budget change on a locked project needs an approved change request; expenses stay audit-only. | `change_request_id` on budget PUT/PATCH (422 `change_request_required`, `change_request_invalid`, `change_request_not_approved`). | ADR 0015; R-121; section 2 item 2 |
| 24 | Defer on a change request (Q-GOV-1) | Parked: the requester or a manager/admin can reopen it to under review. | `POST /api/change-requests/{id}/reopen`; audit `change_request.reopen`. Migration 0076. | ADR 0015; R-120; section 2 item 4 |
| 25 | Decision log and documents (Q-GOV-26, Q-GOV-14, Q-REV-18) | Stay tier B; only managers and admins accept a decision or approve a document, never the document's author; no extra versioning now. | 403 `role_not_permitted`; 422 `decision_accepted_locked`, `author_cannot_approve`, `approve_after_edit`, `supersede_loop`. Migration 0079. | ADR 0015; R-122; section 2 item 5 |

## The rule for the rest

| Rule | Owner choice | Consequence | Where recorded |
|---|---|---|---|
| Follow the common pattern | "Follow the common pattern proven by ClickUp, Lark and others" for every open question that has a proposal. | 63 pattern rows are decided as proposed; 8 were already true; 5 are withdrawn with hour logging (decision 18); 1 was already answered by decision 16. | `journeys/COMMON-PATTERN-ANSWERS.md`; `journeys/DECISIONS-2026-10-17.csv`; ADR 0015 |

## Still open

| Question | Why | Next step |
|---|---|---|
| Q-GOV-22 Old files and document versions | The files of a deleted project are removed after commit (decision 20), but the 30-day clean-up job and keeping replaced files as earlier versions are not built; decision 25 says no extra versioning now. | Owner confirms, or adds it to the backlog. |
| Q-ACC-20 Session length | A Supabase dashboard setting (14 days, Pro plan), not code. | Owner step in `CUTOVER/10-COMMON-PATTERN-ANSWERS.md` section 5. |

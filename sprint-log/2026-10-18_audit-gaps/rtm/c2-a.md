# RTM rows - cycle 2 builder A (non-tier UAT fixes)

## REQUIREMENTS.md bullet

- **R-155** Project edit saves with empty dates (UAT-033). Acceptance: (a) `start_date` and `target_date` accept null on project create and update; (b) PATCH with `start_date: null` saves on an unlocked project; (c) on a locked project a null echoed for an unset date is not a baseline change, and clearing a set date is refused with 422. — **DONE**
- **R-156** Wording and visibility fixes (UAT-029, UAT-030, UAT-031, UAT-032). Acceptance: (a) the evidence document viewer shows the change request as reference and title; (b) a member's tokens export refusal says "Exporting tokens requires an admin or manager session"; (c) the governance badge says "N items in review" for anyone who is not an admin or manager and "N items awaiting your decision" for those who are, and the queue stays visible; (d) UAT-PLAN step 1A-4 is doable by a member. — **DONE**

## Notes for the lead

- Lead asked for an admin-only tokens refusal. `GET /api/tokens` allows managers too, so narrowing the export would have removed access a manager has today. The export keeps admin or manager and the message names both.
- No API payload changed, so there is no openapi notes file.

## Fix pass (review C2-15, C2-16)

- C2-15: `code` now accepts null on project create (also optional) and update. A PATCH test covers `code: null`. Other fields the project form sends, checked against the schemas: `program`, `start_date`, `target_date`, `sponsor`, `project_manager`, `objective`, `business_case`, `scope_summary`, `health_commentary`, `baseline_start_date`, `baseline_target_date` and `backup_owner_id` all accept null; `name`, `rag_status`, `currency` and `phase` are never sent as null (non-null columns). Nothing else rejects null.
- C2-16 (R-156): the comment in the export route now says the tokens export is admin or manager, matching `GET /api/tokens`. Manager access is kept deliberately; the lead accepted this.

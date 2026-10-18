# Tester A new defects found during the retest (no UAT IDs)

Columns follow 01-FINDINGS.md without a UAT ID.

| Date | Reported by | Page / journey | What was expected | What happened | Severity | Screenshot |
|---|---|---|---|---|---|---|
| 2026-10-18 | UAT tester A | Documents, evidence document viewer (step 2-6a) | The linked change request is named by its reference and title, for example CR-009 | The viewer shows "Evidence for change request: Change Control", which is the folder name, not the request | minor | shots/retest-UAT-008-desktop.png |
| 2026-10-18 | UAT tester A | Member export of tokens, GET /api/export?entity=tokens (step 1F-3) | The refusal names the permission needed for a tokens export (admin only) | The 403 says "Listing people requires an admin or manager session", the message for the people export | minor | none |
| 2026-10-18 | UAT tester A | Member sidebar and /api/review | A member, who cannot decide anything, sees no count of items "awaiting your decision" | The member sees a badge "28 items awaiting your decision" next to Governance, and GET /api/review returns the full queue. May be intended visibility, so the badge wording may be the issue | minor | shots/retest-1E-2-desktop.png |
| 2026-10-18 | UAT tester A | Project page for a member, step 1A-4 | The step says try Unlock and expect a refusal naming who can unlock | A member sees no Unlock button, so the refusal text is only reachable through the API. The step cannot be done as written | cosmetic | shots/retest-1A-4-desktop.png |
| 2026-10-18 | UAT tester A | Test environment, dev server | A page keeps its state while a test runs | Fast Refresh rebuilds from other agents' edits reloaded the sign-in page in a loop for about half an hour, and a tab-management call hung. Not a product defect | environment | none |

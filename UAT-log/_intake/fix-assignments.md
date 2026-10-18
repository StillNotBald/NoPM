# Fix assignments, UAT cycle 1

Root causes are in `../02-ROOT-CAUSES.md`. Paths there are relative to `web/`. Write a failing test first for each fix, then fix. Do not edit the UAT-log sheets.

| Owner agent | UAT IDs | One-line fix each |
|---|---|---|
| W4-D github events | UAT-001 | Stop writing a NULL label on deploy-success: pass a real default label (or have the 0105 RPC coalesce) so `tasks.status` stays NOT NULL; `process.ts:129`. |
| W4-D github events | UAT-007 | Add `external_ref`, `source`, `external_url` to the tasks select in `(console)/projects/[id]/page.tsx:69` (and check other task entry points). |
| W4-D github events | UAT-012 | When a PR-opened event moves a task to `started`, also set a default label so the card stops reading "Backlog"; same fix shape as UAT-001. |
| W3-B nudges and reports | UAT-002 | Make `bell.tsx` read the unwrapped array that `apiGet` returns (count unread rows) instead of `data.total` and `data.data`. |
| W3-B nudges and reports | UAT-009 | Change the weekly-report guard in `weekly-report.ts:147` to run only on the chosen weekday (D2), fix comments and tests. |
| W3-A handover | UAT-003 | Stop sending `program: null` from `project-form.tsx:318` (send undefined) or make the schema nullable. |
| W3-A handover | UAT-014 | Let the project header badge group wrap below the title at 1280 px (`projects/[id]/page.tsx:168-197`, `handover-badge.tsx`). |
| W3-A handover | UAT-022 | Replace the raw field-name backup message in `lib/handover/backup.ts:16` with plain language. |
| W4-A tier engine | UAT-004 | Add tier select (Routine only with no cost), Emergency tick box for manager and admin, and approver picker to `change-form.tsx`. |
| W4-A tier engine | UAT-005 | Always show the tier badge and the approval deadline in change detail, Review queue and Approvals (`change-detail.tsx:183`). |
| W4-A tier engine | UAT-010 | Move the Approval policy card mount from the Integrations console to Settings (recommended), or correct the plan; owner confirms. |
| W4-B deletion flow | UAT-006 | Mount the request-deletion button, reason dialog and pending badge on the risk, issue, expense and document panels. |
| W4-B deletion flow | UAT-011 | Show the "Deletion requested" note on those panels using `usePendingDeletionIds` (done with UAT-006). |
| W2-B evidence | UAT-008 | Add `change_request_id` and the evidence columns to the select in `(console)/documents/page.tsx:24` and `projects/[id]/page.tsx:84`. |
| W2-B evidence | UAT-015 | Add a change-request and Evidence section to `document-form.tsx`, or correct OWNER-VISIBLE; default is add. |
| W2-B evidence | UAT-026 | Put a gap between "+ Add summary" and "+ Add body content" (`document-form.tsx:391,412`, `decision-form.tsx`). |
| W2-C audit pack | UAT-013 | Return 422 when `from` is after `to` for export and the audit pack (`_audit-range.ts`, `export/route.ts:515,556`). |
| W2-A implemented stamp | UAT-023 | Impact column falls back to the structured areas when there is no summary (`change-table.tsx:125`). |
| W2-A implemented stamp | UAT-024 | Fix title and last-column clipping in the change table at 1280 px (`change-table.tsx:76,146`). |
| W2-A implemented stamp | UAT-025 | Shorten or widen the "Note (optional)" input in `change-form.tsx:485`. |
| W2-A implemented stamp | UAT-027 | Make the phone status-chip row wrap or show a scroll cue. |
| W1-B lean payloads | UAT-028 | Drop `impact_area` from the full view output only (`lib/api/views.ts:43`), keep it accepted on input; owner may keep it as an alias. |
| tests | UAT-016 | Update the Playwright specs for the collapsed tokens details, double Priority match, Essentials sidebar mode and `role="tab"` tabs. |
| tests | UAT-017 | Update probe fixtures: GH3 and GH6 SQL, send `expected_updated_at` in API11 and LK-X1 (after UAT-001 is fixed). |
| docs | UAT-019 | Update the UAT plan step 1C-4: Risk category dropdown exists, no "safety" impact area. |
| docs | UAT-020 | Update plan steps 1E and 1F: People page, "Export people (CSV)", `/api/export?entity=members`, Trust button label (W1-C may rename it). |
| docs | UAT-021 | Fill the empty Wave 2 table in the UAT plan. |
| owner decision | UAT-018 | Decide whether a replayed deletion-request approve should be an idempotent 200 or a 422; then align route, probe API8 and openapi text. |

Fan-out summary: W4-D 3, W3-B 2, W3-A 3, W4-A 3, W4-B 2, W2-B 3, W2-C 1, W2-A 4, W1-B 1, tests 2, docs 3, owner decision 1.

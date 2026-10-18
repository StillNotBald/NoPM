# Retest A (cycle 1, fix pass dbead57)

Columns follow 03-RETEST-SHEET.md. Retest date 2026-10-18 for every row. Screenshots are under testing-log/2026-10-18_uat-cycle-1/shots/.

| UAT ID | Retest date | Retested by | Method (page path / API call) | Outcome | Notes |
|---|---|---|---|---|---|
| UAT-008 | 2026-10-18 | UAT tester A | /documents, open DOC-020, read the viewer | fixed | Viewer shows evidence type, result, tested by, tested on, note. The change request is labelled "Change Control" instead of CR-009 (new row in tester-a-new). shots/retest-UAT-008-desktop.png |
| UAT-013 | 2026-10-18 | UAT tester A | Admin session GET /api/export?entity=audit_pack&from=2026-10-31&to=2026-10-01 | fixed | 422 "from must not be after to". A valid range still returns 200 |
| UAT-014 | 2026-10-18 | UAT tester A | /projects/055da553-9359-45e7-8606-cdc3ece166f7 at 1280 px | fixed | Title is on one line, badges do not overlap. shots/retest-UAT-014-desktop.png |
| UAT-015 | 2026-10-18 | UAT tester A | /documents, New Document, pick CR-009 in the change request field | fixed | Field "Attach as evidence for a change request (optional)" shows, and an Evidence section appears once a request is chosen. shots/retest-UAT-015-desktop.png |
| UAT-019 | 2026-10-18 | UAT tester A | Read UAT-PLAN.md step 1C-4 | fixed | Plan now says the free-text Category is gone and a Risk category dropdown is correct. The "safety" example is gone |
| UAT-020 | 2026-10-18 | UAT tester A | Read UAT-PLAN.md steps 1E, 1F, 1G, then GET /api/export/tokens | still present | 1E-1, 1E-3 and 1G-1 are corrected. Step 1F-3 still says /api/export/tokens, which returns 404. The real address is /api/export?entity=tokens |
| UAT-021 | 2026-10-18 | UAT tester A | Read UAT-PLAN.md Wave 2 table and ran 2-1 to 2-10 | fixed | The table now lists steps 2-1, 2-2, 2-3, 2-4, 2-5, 2-6a, 2-6b, 2-6c, 2-7, 2-8, 2-9 and 2-10. All ran |
| UAT-023 | 2026-10-18 | UAT tester A | /change-control, row CR-009 and CR-023 Impact column | fixed | Shows "Schedule down, Cost up". shots/retest-UAT-024-desktop.png |
| UAT-024 | 2026-10-18 | UAT tester A | /change-control at 1280 px | fixed | Titles wrap on two lines, all columns including Requested by are visible, table fits its container. shots/retest-UAT-024-desktop.png |
| UAT-025 | 2026-10-18 | UAT tester A | /change-control, Raise Change Request at 390 px, Impact by area | fixed | Placeholder reads "Note", full width, not clipped. shots/retest-UAT-025-phone.png |
| UAT-026 | 2026-10-18 | UAT tester A | /documents, New Document at 1280 px, the two disclosure buttons | fixed | "+ Add summary" and "+ Add body content" are 16 px apart. Decision form not re-checked on a phone. shots/retest-UAT-015-desktop.png |
| UAT-027 | 2026-10-18 | UAT tester A | /change-control at 390 px | fixed | The seven chips wrap onto three rows and all are visible. shots/retest-UAT-027-phone.png |
| UAT-028 | 2026-10-18 | UAT tester A | Token GET /api/projects/<id>/risks?view=full | fixed | Keys include impact_areas, no impact_area, no category |

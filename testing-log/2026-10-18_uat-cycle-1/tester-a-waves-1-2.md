# UAT cycle 1 - tester A - waves 1 and 2

Date: 2026-10-18. Build: local dev server (http://localhost:3000), local Supabase, migrations 0001-0105 with seed data. Tester: UAT tester A. No code, git or env file was touched.

## Deviations that apply to many steps

- Only the admin identity (Jordan Hale, demo one-click login) was available. Manager and member logins have random seed passwords, and the demo session cannot mint tokens ("Not available in the shared demo"). Steps that need a manager, a member or an agent token are BLOCKED. Steps that name a manager but only need "a person" were run as admin and say so.
- API checks used the admin cookie session with curl, not a Bearer token.
- The plan's Wave 2 table is empty. The Wave 2 steps below (prefix 2-) were derived by the tester from the Wave 2 rows of OWNER-VISIBLE.md.
- Records created by this tester: risks "UAT-A phone risk three areas" and "UAT-A desktop risk three areas" (project CDP-CORE), CR-009 "UAT-A change request impact by area", DEC-007 "UAT-A decision linked to CR-009", DOC-020 "Evidence for CR-009". Project ECM-WEB was locked (reason "Baseline frozen") and left locked.
- Screenshots are in the shots folder next to this file. "API" means no screenshot, the result came from curl.

## Wave 1

| Step | Result | What I saw | Screenshot |
|---|---|---|---|
| 1A-1 | PASS (as admin) | Lock dialog, then badge "Locked by Jordan Hale" plus a lock reason bar. Run as admin because no manager login exists. At 1280 px the title is squeezed into a narrow column and the "On track" badge overlaps "Global" (finding). | shots/1A-1-desktop.png, shots/1A-1b-desktop.png |
| 1A-2 | PASS | Phone 390 px: badges wrap under the title, no overlap, no horizontal scroll (scrollWidth 390). | shots/1A-2-phone.png |
| 1A-3 | BLOCKED | Needs a lock made by a manager and viewed by an admin. No manager login. The seeded lock on ERP-EMEA already names Jordan Hale through the API. | API |
| 1A-4 | BLOCKED | Needs a member login to try Unlock. | none |
| 1A-5 | PASS (actor is admin) | Trust Center stream shows project.lock with actor Jordan Hale (user, ui) and a request id. The target shows only a short id, not the project code. | shots/1A-5-desktop.png |
| 1B-1 | BLOCKED | Tokens page "Mint agent token" returns "Not available in the shared demo". Same from the API. The preset scope list does include risk:write, issue:write and project:write, and says it can lock but never unlock. | shots/1B-1-desktop.png |
| 1B-2 | BLOCKED | Needs the token from 1B-1. | none |
| 1B-3 | BLOCKED | Needs 1B-2. | none |
| 1B-4 | BLOCKED | Needs 1B-2. | none |
| 1C-1 | PASS | Phone: saved with Schedule, Cost, Quality. The drawer reads "Impact Areas: Schedule, Cost, Quality". The API confirms all three. | shots/1C-1-phone.png, shots/1C-1b-phone.png |
| 1C-2 | PASS | Phone form: chips wrap onto two lines, no field cut off, scrollWidth 390. The Next dev badge covers the Cancel button (environment). | shots/1C-2-phone.png |
| 1C-3 | PASS | Desktop: Scope, Reputation, Compliance saved. The API confirms. | shots/1C-4-desktop.png |
| 1C-4 | FAIL (plan wording) | The form has a "Risk category" dropdown with eight fixed values. The free-text Category is gone, which matches OWNER-VISIBLE, but the plan says no category at all. The plan also names a "safety" impact area that does not exist. | shots/1C-4-desktop.png |
| 1D-1 | PASS (cookie) | /api/projects?view=summary returns 10 projects with 13 keys each and no description. | API |
| 1D-2 | PASS (cookie) | view=full returns 36 keys each, including description, owner and lock fields. | API |
| 1D-3 | PASS (cookie) | fields=id,code,name returns exactly those three keys. | API |
| 1D-4 | PASS (cookie) | No view parameter returns the same 13 keys as summary. | API |
| 1D-5 | PASS (cookie) | Per-project risks with view=summary has no category key. view=full has no category either, but still carries the old single impact_area key beside impact_areas. | API |
| 1E-1 | PASS | The People page (not Settings -> Members) has "Export people (CSV)" and "Export chat links (CSV)". The members file has a header and 4 rows. Plan label and location are stale (finding). | shots/1E-1-desktop.png, shots/1E-1-phone.png |
| 1E-2 | BLOCKED | Needs a member login. | none |
| 1E-3 | BLOCKED | Needs a member login. The plan's address /api/export/members returns 404 even for admin. The real address is /api/export?entity=members (finding). | API |
| 1E-4 | BLOCKED | The seed has no removed members, so the check has nothing to test. | API |
| 1F-1 | PASS | Tokens page has "Export tokens (CSV)". The download returns nopm-tokens-2026-10-18.csv. | shots/1F-1-desktop.png (page still loading in this shot) |
| 1F-2 | PASS | Columns: id, label, prefix, scopes, created_by, created_by_label, created_at, expires_at, revoked, last_used_at. Prefix is only "npm_". No secret. | API |
| 1F-3 | BLOCKED | Needs a member login. | none |
| 1G-1 | PASS | The Trust Center button is "Export CSV" (plan says "Export audit (CSV)"). The file downloads with 19 columns. | shots/1A-5-desktop.png |
| 1G-2 | BLOCKED | Needs a token action. The principal_id column exists and is empty on the human rows. | API |
| 1G-3 | BLOCKED | Needs 1B-2. | none |

## Wave 2 (derived steps)

| Step | Result | What I saw | Screenshot |
|---|---|---|---|
| 2-1 Change Control shows the Implemented status | PASS | Chips: Raised 2, Under review 3, Approved 3, Implemented 0, Rejected 1, Deferred 0, All 9. On a phone the Implemented chip is off screen until the chip row is scrolled. | shots/2-1-desktop.png, shots/2-1-phone.png |
| 2-2 Mark implemented on an approved request | BLOCKED | Seed CR-005 (approved) shows a "Go live" block with an optional note and "Mark implemented". I did not press it: it cannot be undone and CR-005 is a seed record. My own CR cannot be approved by me (four-eyes message shown) and there is no second approver login. | shots/2-2-desktop.png, shots/2-2-phone.png |
| 2-3 Impact by area | PASS | The raise form has six area selects (Scope, Schedule, Cost, Quality, Resources, Compliance) and a note field per chosen area. The saved CR shows "Schedule: decrease, Cost: increase, UAT-A cost note". Phone detail also fine. The list Impact column shows a dash for this request. | shots/2-3-desktop.png, shots/2-2-phone.png |
| 2-4 Decision links to a change request | PASS | The decision form has a Change request picker and an options list with a Chosen radio. Saved as DEC-007. CR-009 detail shows "DECISIONS: 1" with a link. The phone form has no horizontal scroll. I did not open the decision detail to read the Chosen option. | shots/2-4-desktop.png, shots/2-4b-desktop.png, shots/2-4c-desktop.png, shots/2-4-phone.png |
| 2-5 Attach evidence to a change request | PASS | Panel "Test and UAT evidence" with Attach evidence. Saved Test result, Pass, tested by Jordan Hale, date and note. The phone form fits. | shots/2-5-desktop.png, shots/2-5b-desktop.png, shots/2-5-phone.png |
| 2-6a Document viewer shows the evidence | FAIL | The DOC-020 viewer shows folder, project, owner, dates and history, but no evidence type, result, tester, note or linked change request. | shots/2-6-phone.png |
| 2-6b Document form has an Evidence section | FAIL | The New Document form has no change request field and no evidence section. Evidence can only be added from Change Control. | none |
| 2-6c Documents API filter and refusal | PASS | ?change_request_id= returns only DOC-020 with all evidence fields. Sending evidence fields without a change request returns "Evidence fields need a change request". | API |
| 2-7 Audit pack | PASS | Change Control and Trust Center both have "Audit pack". The panel offers from and to dates, Download PDF and Download CSV. CSV sections: change_requests, evidence, decisions, approvals_audit. The PDF is a valid PDF. Each download wrote an export.audit_pack audit row (3 rows after 3 calls). A reversed date range returns 200 instead of an error. Non-admin refusal not tested. | shots/2-7-desktop.png |
| 2-8 change_requests export entity | PASS | CSV with approver, decision, impact_scope, implemented_at, evidence counts and linked_decisions, plus the wave 4 tier and retro columns. | API |
| 2-9 Read-only lean lists | PASS | /api/change-requests and /api/decisions return lean rows by default, with change_request_id on decisions. /api/projects/<id>/evm returns bac, pv, ev, ac, cpi, spi and more. | API |

## Checks on every new or changed screen at 390 px

- No horizontal page scroll on Change Control, the change request panel, the evidence form, the decision form, People, the risk form, the risk drawer and the project page (scrollWidth equals 390 on each).
- Console errors: one hydration warning on the Risks page, caused by the test browser adding a caret-color style to the search input (environment). No other errors.

## Not run

- 1A-3, 1A-4, 1E-2, 1E-3, 1F-3: need a manager or member login that the environment does not provide.
- 1B-1 to 1B-4, 1G-2, 1G-3: need an agent token. The shared demo login cannot mint one.
- 1E-4: no removed members in the seed data.
- 2-2 Mark implemented, the edit and delete lock after implementing, and "editing a pending request re-issues the approval card": need an approver other than the requester, and pressing Mark implemented on a seed record is irreversible.
- 2-3 on the phone Raise form: only the detail view was checked at 390 px.
- Wave 2 MCP tools (list change requests, get one, list decisions, get a document, earned value): the MCP server is not wired to this local stack in my session, so only the equivalent REST reads were checked.
- Non-admin refusal of the audit pack, and the member view of Change Control.

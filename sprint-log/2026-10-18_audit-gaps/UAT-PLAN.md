# UAT plan — audit-gap programme (CR-2026-10-18-01)

**Who runs this:** a non-developer tester, with the owner or a stand-in playing each role.
**Where:** the NoPM site the owner names for the round (the live demo or the local dev server with seed data).
**What you need:** a manager login, an admin login, a member login, a phone (or a browser window resized to 390 px wide), and one agent token created by an admin.

## How to use these tables

- Run the steps in order inside each wave. Later steps rely on earlier ones.
- **Role** says which login to use. **Device** is either `Phone 390 px` or `Desktop`.
- **Expect** is what you should see. If it differs, mark **Fail** and write what you saw in a new row in `UAT-log/01-FINDINGS.md`. Do not fix anything yourself.
- Put **Pass** or **Fail** in the last column. Do not write counts in this file.
- Tokens shown on screen are shown once. Copy the value into a note before you leave the page.

## Wave 1 — foundation (schema integrity, lean payloads, access review)

### 1A. Locking a project and seeing who locked it

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 1A-1 | Manager | Desktop | Open a project that is not locked. Click **Lock**. | The project shows a lock badge. The badge text names your own name as the locker. | |
| 1A-2 | Manager | Phone 390 px | Open the same project on the phone. | The lock badge is visible and does not overlap the title. The locker name is shown in full or truncated with `…`, never cut mid-letter. | |
| 1A-3 | Admin | Desktop | Open the same project. | The lock badge names the manager from step 1A-1, not the admin. | |
| 1A-4 | Member | Desktop | Open the same project and try to **Unlock**. | Unlock is refused. The message names who can unlock (a manager or admin). | |
| 1A-5 | Manager | Desktop | Open the **Trust Center** and find the lock audit row for this project. | The row shows the manager as the actor. | |

### 1B. Locking through an agent token

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 1B-1 | Admin | Desktop | Create an agent token with a label such as `UAT agent lock`. Copy the token into a note. | The token is shown once with its label. | |
| 1B-2 | Tester | Desktop | Using the token and a tool or `curl`, lock a second unlocked project. Use `POST <NoPM URL>/api/projects/<project id>/lock` with header `Authorization: Bearer <token>`. | The response is success (`{ "data": … }`). | |
| 1B-3 | Admin | Desktop | Open the locked project. | The lock badge names the token label `UAT agent lock`, not a person's name. | |
| 1B-4 | Admin | Desktop | Open the audit trail for that project. | Exactly one lock row exists for this action. It records the token as the actor. | |

### 1C. Risk create with several impact areas

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 1C-1 | Manager | Phone 390 px | Open a project, go to **Risks**, tap **New risk**. Enter a title. Select at least three impact areas (for example schedule, cost, safety). Save. | The risk saves. The new risk lists all three impact areas. | |
| 1C-2 | Manager | Phone 390 px | Look at the create form on the phone. | No field is cut off on the right. The impact-area chips wrap onto new lines. There is no horizontal page scroll. | |
| 1C-3 | Manager | Desktop | Repeat step 1C-1 on desktop. | The same three impact areas appear on the saved risk. | |
| 1C-4 | Manager | Desktop | Look at the create form for a **Category** field. | There is no **Category** field. Risk categories are no longer shown. | |

### 1D. Lean list payloads (through `curl` with a token)

Use the same token from step 1B-1. Replace `<project id>` with a real project id. Each request is a `GET`. Put the token in the `Authorization: Bearer` header.

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 1D-1 | Tester | Desktop | Run `curl -H "Authorization: Bearer <token>" "<NoPM URL>/api/projects?view=summary"`. | A list comes back in `{ "data": … }`. Each project has only the summary fields (for example id, code, name, status). | |
| 1D-2 | Tester | Desktop | Run `curl -H "Authorization: Bearer <token>" "<NoPM URL>/api/projects?view=full"`. | The same projects come back with more fields per project (for example description, budget, owner). | |
| 1D-3 | Tester | Desktop | Run `curl -H "Authorization: Bearer <token>" "<NoPM URL>/api/projects?fields=id,code,name"`. | Each project has exactly three keys: `id`, `code`, `name`. | |
| 1D-4 | Tester | Desktop | Run the same three requests with no `view` parameter at all. | The result matches `?view=summary`. Summary is the default. | |
| 1D-5 | Tester | Desktop | Run `curl` on `<NoPM URL>/api/projects/<project id>/risks?view=summary`. | Each risk has summary fields and no `category` key. | |

If you use the MCP server instead of `curl`, call the `list_projects` tool and ask for the summary, then the full view. The two results must differ in the same way.

### 1E. Members CSV export

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 1E-1 | Admin | Desktop | Open **Settings** → **Members**. Click **Export members (CSV)**. | A `.csv` file downloads. Open it. It has one row per member and a header row. | |
| 1E-2 | Member | Desktop | Log in as a member. Open **Settings** → **Members**. | The export button is not shown. | |
| 1E-3 | Member | Desktop | Enter the members export address directly in the address bar: `<NoPM URL>/api/export/members`. | The page refuses with a message that names the permission needed. No file downloads. | |
| 1E-4 | Admin | Desktop | Open the downloaded CSV. | No email addresses of people who have left the workspace appear, unless the admin still has them as members. | |

### 1F. Tokens CSV export

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 1F-1 | Admin | Desktop | Open **Tokens**. Click **Export tokens (CSV)**. | A `.csv` file downloads. | |
| 1F-2 | Admin | Desktop | Open the CSV. | Each token has its label, its scopes and its creation date. No token value (the secret) appears in the file. | |
| 1F-3 | Member | Desktop | Enter `<NoPM URL>/api/export/tokens` in the address bar as a member. | Refused with a message that names the permission needed. | |

### 1G. Audit CSV showing the human behind a token

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 1G-1 | Admin | Desktop | Open **Trust Center** → **Audit**. Click **Export audit (CSV)**. | A `.csv` file downloads. | |
| 1G-2 | Admin | Desktop | Open the CSV and find a row created by the agent token from step 1B-1. | The row has a `principal_id` column. The value identifies the human who created the token, so the row is traceable to a person. | |
| 1G-3 | Admin | Desktop | Find the same lock row from step 1B-4 in the CSV. | The `principal_id` matches the human who created the token. | |

## Wave 2 — change-request evidence chain

Scope: a change request records when it was implemented, links to its decision, and carries structured scope; evidence can be attached to it; an audit pack can be exported; change requests and decisions are readable through the MCP server.

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| | | | | | |

## Wave 3 — runs without you

Scope: a handover report names the backup owner for each project and shows key-person risk; stale items send nudges; a weekly report reaches in-app notifications and an email preview; forecasts use estimate-to-complete; snapshots show drift and slip trends; project dependencies and contingent flags roll up across the portfolio.

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 3-1 | Member | Phone 390 px | Open a project that has no backup owner. Look at the project header. | A **No backup owner** badge shows. It does not overlap the title. | |
| 3-2 | Manager | Phone 390 px | Open the project edit form. Open the **Backup owner** picker, choose a person other than the owner, and save. | The backup owner saves and shows on the project. The picker lists people in this workspace only, and no field is cut off. | |
| 3-3 | Manager | Phone 390 px | Set the backup owner to the same person as the owner, and save. | The save is refused with a message that the backup must be a different person from the owner. | |
| 3-4 | Manager | Phone 390 px | Open **Handover** from the Portfolio section of the navigation. | Open items with an owner and no backup appear under that owner, with counts. Unowned items appear in their own list. The cards stack, with no horizontal scroll. | |
| 3-5 | Manager | Desktop | On the Handover page, select **Export CSV**. | A CSV downloads. Its first column is `section`, and each row reads `item`, `unowned` or `person`. | |
| 3-6 | Manager | Desktop | Open **Integrations**. Find the **Nudges and weekly report** card beside the time zone. Set the stale threshold to 3 days and save. Reload. | The card shows 3 after the reload. | |
| 3-7 | Member | Desktop | After the daily tick has run, open an open task whose last update is more than 3 days old. Check your notifications. | One stale-item notification appears for that task, with a link to it. Refreshing the page the same day adds no new notification. | |
| 3-8 | Admin | Desktop | On the Integrations page, select **Send weekly report now**. | A success message appears. Every admin and manager gets a weekly report notification. | |
| 3-9 | Manager | Phone 390 px | Open the weekly report notification. | The report opens as a page with project codes and a project table. It reads at phone width. | |
| 3-10 | Admin | Desktop | Open **Email previews**. Find the weekly report and the stale-item samples. | Both render as previews. Nothing is sent to any inbox. | |
| 3-11 | Manager | Desktop | Open **What changed** from the Portfolio section. Set the project, kind, person and date filters. | Only matching rows show, newest first, grouped by day, 50 per page. | |
| 3-12 | Manager | Desktop | Open the **Budget** page for a project. In **Forecast and trend**, enter an estimate to complete and change the method to bottom-up. | Both forecasts show, EAC (CPI) and EAC (bottom-up). The method is named beside EAC, and the figures recalculate. | |
| 3-13 | Manager | Phone 390 px | Check the **Forecast and trend** card at phone width. | The estimate input and the method selector stack, and neither overlaps the figures. | |
| 3-14 | Manager | Desktop | On the Budget page, read **Suggested RAG** beside the declared RAG. | The suggestion shows its reason and the line "Advice only; the declared RAG is yours to set". The declared RAG keeps the value you set. | |
| 3-15 | Manager | Desktop | Open **Approvals** and switch between **Mine** and **All**. | **Mine** shows only requests assigned to you, and its count matches. With none assigned, it shows "nothing assigned to you". | |
| 3-16 | Manager | Desktop | Open a project and its **Project dependencies** panel. Add a dependency on another project with a kind and a note. Then remove it. | The dependency lists under "depends on" after adding. It disappears after removing. | |
| 3-17 | Manager | Desktop | Declare a dependency that would close a loop, for example A depends on B when B already depends on A. | The save is refused, with a message that a circular dependency is not allowed. | |
| 3-18 | Manager | Desktop | Declare a dependency from a green project on a red one. Open **Portfolio**. | The green project shows an amber **Contingent** tag. Hovering the tag names the red project. The project's own health colour and label do not change. | |

## Wave 4 — governance tiers, deletion flow, atomic audit, work events

Scope: approval tiers with routing, timers and an emergency path; deletion by request for expenses, documents, risks, issues and milestones; every mutation writes its audit row atomically with a tamper-evident hash chain; signed GitHub events move matching tasks without touching locked projects.

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| | | | | | |

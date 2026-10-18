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
| 1C-1 | Manager | Phone 390 px | Open a project, go to **Risks**, tap **New risk**. Enter a title. Select at least three impact areas (for example schedule, cost, quality). Save. | The risk saves. The new risk lists all three impact areas. | |
| 1C-2 | Manager | Phone 390 px | Look at the create form on the phone. | No field is cut off on the right. The impact-area chips wrap onto new lines. There is no horizontal page scroll. | |
| 1C-3 | Manager | Desktop | Repeat step 1C-1 on desktop. | The same three impact areas appear on the saved risk. | |
| 1C-4 | Manager | Desktop | Look at the create form for a **Category** field. | The free-text **Category** field is gone. A **Risk category** dropdown with its fixed values is shown, and that is correct. Impact areas are a checkbox group. | |

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
| 1E-1 | Admin | Desktop | Open the **People** page. Click **Export people (CSV)**. | A `.csv` file downloads. Open it. It has one row per member and a header row. | |
| 1E-2 | Member | Desktop | Log in as a member. Open the **People** page. | The export button is not shown. | |
| 1E-3 | Member | Desktop | Enter the members export address directly in the address bar: `<NoPM URL>/api/export?entity=members`. | The page refuses with a message that names the permission needed. No file downloads. | |
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
| 1G-1 | Admin | Desktop | Open **Trust Center** → **Audit**. Click **Export CSV**. | A `.csv` file downloads. | |
| 1G-2 | Admin | Desktop | Open the CSV and find a row created by the agent token from step 1B-1. | The row has a `principal_id` column. The value identifies the human who created the token, so the row is traceable to a person. | |
| 1G-3 | Admin | Desktop | Find the same lock row from step 1B-4 in the CSV. | The `principal_id` matches the human who created the token. | |

## Wave 2 — change-request evidence chain

Scope: a change request records when it was implemented, links to its decision, and carries structured scope; evidence can be attached to it; an audit pack can be exported; change requests and decisions are readable through the MCP server.

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 2-1 | Admin | Desktop, then Phone 390 px | Open **Change Control**. Read the status chips. Then look at the chips at 390 px. | Chips for Raised, Under review, Approved, Implemented, Rejected, Deferred and All show, each with a count. At 390 px all of them are visible without scrolling the chip row sideways. | |
| 2-2 | Admin (a different person from the requester) | Desktop | Open a change request that a second person has approved, not a seed record you need to keep. Read the **Go live** block. Add an optional note and press **Mark implemented**. | The status becomes Implemented, with the date and the person. The Edit and Delete controls are gone. Note: this cannot be undone, so use a throwaway request. | |
| 2-3 | Manager | Desktop, then Phone 390 px | Raise a change request. Under **Impact by area**, choose Schedule (decrease) and Cost (increase), type a note for the Cost area, and save. Open the list. | The saved request shows Schedule: decrease and Cost: increase, with the note. The Impact column in the list shows the impact. At 390 px the raise form fits, and no field is cut off. | |
| 2-4 | Manager | Desktop | Open **Decisions** and add a decision. Choose the change request in the **Change request** picker, mark one option as Chosen, and save. Open the change request. | The decision saves. The change request shows "Decisions: 1" with a link to the decision. The Chosen option is shown on the decision. The phone form has no horizontal scroll. | |
| 2-5 | Manager | Desktop, then Phone 390 px | On a change request, open the **Test and UAT evidence** panel, press **Attach evidence**, and enter a test result, the tester, a date and a note. Save. | The evidence is listed on the change request. The phone form fits at 390 px. | |
| 2-6a | Manager | Desktop, then Phone 390 px | Open the document that holds the evidence from 2-5 (the document created for that change request). | The viewer shows the evidence type, result, tester, note and the linked change request, as well as its folder, project and history. | |
| 2-6b | Manager | Desktop | Open **New document**. Look for a change request field and an Evidence section. | The form has a change request field and an Evidence section. | |
| 2-6c | Tester | Desktop, address bar or curl | Request the documents list filtered by `change_request_id` for the request from 2-5. Then send evidence fields in a document with no change request. | The filter returns only that request's documents, with all the evidence fields. Evidence fields without a change request are refused with "Evidence fields need a change request". | |
| 2-7 | Admin | Desktop | Open **Change Control**, then the **Audit pack** panel. Choose a from and to date. Download the PDF and then the CSV. | Both files download. The CSV has the sections change_requests, evidence, decisions and approvals_audit. Each download adds an export.audit_pack row to the audit log. A reversed date range is refused. | |
| 2-8 | Tester | Desktop, address bar or curl | Request the change requests export (`/api/export?entity=change_requests`). | The CSV has approver, decision, impact scope, implemented date, evidence counts and linked decisions, plus the tier and retro columns. | |
| 2-9 | Tester | Desktop, address bar or curl | Read the change requests list and the decisions list. Read the EVM figures for a project. | Both lists are lean by default. Each decision carries `change_request_id`. The EVM figures include bac, pv, ev, ac, cpi and spi. | |
| 2-10 | Tester | Desktop, with an MCP client connected to the local stack | Call list_change_requests, get_change_request, list_decisions, get_document and get_evm. | Each tool returns the same data as the matching REST read in 2-8 and 2-9. Nothing is written. | |

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

Steps 4-19 to 4-23 need a GitHub repository that the tester can change, and a task you may link. Step 4-22 needs the release window to have run, so the connector exists.

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 4-1 | Admin | Phone 390 px | Open **Settings** and find the **Approval policy** card, below the Invites section. Admins and managers see it, and only admins can edit it. | Five rows, one per tier, each showing who decides it and its turnaround hours. Below them: a routine-only auto-approve checkbox with a warning, the cost threshold, the currency and the emergency window. The rows stack, and nothing scrolls sideways. | |
| 4-2 | Admin | Desktop | Change the cost threshold to 20000 and save. Reload the page. | The field shows 20000 after the reload. The save writes one audit row. | |
| 4-3 | Manager | Desktop | Raise a change request on a test project with an impact cost of 10000 and the default tier. | The change shows the tier **Normal** and an approval deadline. | |
| 4-4 | Manager | Desktop | Raise a change request on the same project with an impact cost of 60000. | The change shows the tier **High risk**, because the cost is over the threshold you set in 4-2. | |
| 4-5 | Manager | Desktop | Raise a change request with the tier set to **Routine** and an impact cost of 1000. | The save is refused. The message names the tier field and says routine needs no cost. | |
| 4-6 | Manager | Desktop | Open the High risk change from 4-4 and try to approve it. | Approval is refused with the message "This request needs an admin to decide it." | |
| 4-7 | Admin | Desktop | Open the same change and approve it, with a rationale. | The change is approved. The admin is not the requester, so four-eyes allows it. | |
| 4-8 | Manager | Desktop | On the project, raise a change request and tick **Emergency**. | The change shows the status **Emergency**, a retro deadline about 48 hours away, and no ordinary deadline. | |
| 4-9 | Manager | Desktop | Open the emergency change and press **Mark implemented**. | The status becomes implemented. An emergency note shows the retro deadline. | |
| 4-10 | Admin | Desktop | Open the emergency change and record an approve retro decision. | The note shows the retro decision as given. The change stays implemented. | |
| 4-11 | Admin | Desktop | Open **Approvals**. Find an emergency whose retro deadline has passed and has no retro decision. (Ask the developer to set one up with a past deadline if none exists.) | The item shows a red **Overdue** marker. The same item is named in the digest and the weekly report. | |
| 4-12 | Admin | Desktop | Open **Settings**, and the Approval policy card there. Confirm the routine auto-approve checkbox is unchecked. Then look at a routine change nobody has decided, after its deadline has passed. | The routine change is still waiting. It is not approved. Admins receive an escalation notice. | |
| 4-13 | Manager | Desktop | On a test risk, press **Request deletion**, enter a reason and submit. | The risk stays in the register, with a **Deletion requested** note. No risk is removed. | |
| 4-14 | Manager | Desktop | Sign in as a different manager. Open **Approvals**. Find the risk deletion. Read what approving removes, then approve it. | The request shows the risk and its reason, and the approval removes the risk. | |
| 4-15 | Manager | Desktop | Open a milestone that has tasks, and request its deletion with a reason. | The request shows the number of tasks the milestone holds, as "removes N tasks". | |
| 4-16 | Admin | Desktop | Approve the milestone deletion from 4-15 as a different person. | The milestone is removed. Its tasks remain, with no milestone set. | |
| 4-17 | Admin | Desktop | Open **Trust Center** and find the chain line. Press **Verify now**. | The line reads "Chain verified" with a row count and the last check time. A new audit row appears for the check. | |
| 4-18 | Member | Desktop | Open **Trust Center** as a member. | The chain line may show. The **Verify now** button is not shown. | |
| 4-19 | Admin | Desktop | Open **Integrations**. In the **GitHub** card, press **Connect**. Copy the webhook address and the secret, which is shown once. | The card shows the connection as live, with the address. The secret is shown exactly once. | |
| 4-20 | Admin | Phone 390 px | Open the **GitHub** card at phone width. | The four status selects and the events list stack. Nothing overlaps. | |
| 4-21 | Manager | Desktop | On a task, open the detail panel and enter a pull request in **Link PR**, as `owner/repo#number`. Save. | The field stores the reference and shows it on the task. | |
| 4-22 | Tester | Desktop | In the GitHub repository, add the webhook with the address and secret. Content type `application/json`. Events: Pull requests and Deployment statuses. Open **Recent deliveries**. | The ping delivery shows a green tick. | |
| 4-23 | Tester | Desktop | Open the linked pull request on GitHub, then merge it. Return to the task. | The task moves to the status the mapping gives: Started on open, In review on merge. The GitHub card lists both deliveries as applied. | |
| 4-24 | Manager | Desktop | Lock the project of a linked task, then open and merge its pull request. | The task does not move. The GitHub card lists the event with the reason "project locked". | |
| 4-25 | Admin | Desktop | On the GitHub card, pause the connection. Send a new delivery from GitHub. | GitHub shows the delivery as failed with a 401. The card shows the connection as paused. | |

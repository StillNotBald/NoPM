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
| | | | | | |

## Wave 4 — governance tiers, deletion flow, atomic audit, work events

Scope: approval tiers with routing, timers and an emergency path; deletion by request for expenses, documents, risks, issues and milestones; every mutation writes its audit row atomically with a tamper-evident hash chain; signed GitHub events move matching tasks without touching locked projects.

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| | | | | | |

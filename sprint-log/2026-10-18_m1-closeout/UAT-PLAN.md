# UAT plan: M1 close-out and agent evidence (CR-2026-10-18-02) - SKELETON

Skeleton written at planning time. Wave 3's documentation builder fills in exact labels and button names after each wave ships. Steps marked **Dev** need a developer or the lead (SQL or a stopped database); the tester watches the result.

**Who runs this:** a non-developer tester, with the owner or a stand-in playing each role.
**Where:** the local dev server with seed data (`BASE=http://localhost:3000`). Never the live site.
**What you need:** a manager login, an admin login, a member login, a phone or a browser window at 390 px wide, one agent token created by an admin, and for wave 2 a second local Postgres started with `docker compose -f docker-compose.anchor.yml up -d`.

## How to use these tables

- Run the steps in order inside each wave. Later steps rely on earlier ones.
- **Role** says which login to use. **Device** is `Phone 390 px` or `Desktop`.
- **Expect** is what you should see. If it differs, mark **Fail** and add a row to `UAT-log/01-FINDINGS.md`. Do not fix anything yourself.
- Put **Pass** or **Fail** in the last column. No counts in this file.
- Tokens are shown once. Copy the value to a note first.

## Wave 1: atomic write path, task blocker and ETA, last sign-in

The point of 5A to 5C: nothing looks different. Every action below must behave exactly as before and leave exactly one audit row.

### 5A. Change requests, rebaselines and deletion requests

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 5A-1 | Manager | Desktop | Raise a normal change request, then edit its title, then withdraw it. | Each step works as before. In the audit trail the three rows (create, update, withdraw) appear, one each. | |
| 5A-2 | Manager | Phone 390 px | Propose a rebaseline on a test project. | The draft saves. The page has no horizontal scroll. One `rebaseline.create` row appears. | |
| 5A-3 | Manager | Desktop | Press **Request deletion** on a test task, then on a test project. | Both show "Deletion requested". Nothing is removed. One `delete_requested` row each. | |
| 5A-4 | Manager | Desktop | Withdraw the task request, then reopen it from the requester's list. | Both actions work. One audit row each. | |
| 5A-5 | Manager | Desktop | Raise an emergency change request. | It commits at once with the emergency flag, exactly as in cycle 2. Two audit rows, no change in wording. | |
| 5A-6 | **Dev** | n/a | With the lead, force the audit half to fail on a throwaway workspace (probe script) and raise a change request. | The request answers an error and no change request row exists afterwards. | |
| 5A-7 | Admin | Desktop | Open the Trust Center and press **Verify now**. | The chain still verifies. | |

### 5B. Sign-in security and connectors

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 5B-1 | Member | Phone 390 px | Enrol in two-step sign-in, confirm with a code, then disable it. | Each step works as before. Three audit rows. No secret or backup code appears in any audit row. | |
| 5B-2 | Member | Phone 390 px | Enter a wrong code five times. | The lockout message appears as before. | |
| 5B-3 | Admin | Desktop | Create a chat connector, rotate its secret, pause it. | Secret shown once. Audit rows exist. No secret in the audit rows. | |
| 5B-4 | Admin | Desktop | Create and revoke the GitHub connector. | Works as in cycle 2. | |
| 5B-5 | Member | Desktop | Link a chat identity with a link code. | The identity links. Reusing the same code is refused. | |
| 5B-6 | Admin | Desktop | Mint the assistant's ephemeral token by sending one assistant message, then revoke it. | Works as before. Audit rows present. | |

### 5C. Unattended jobs

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 5C-1 | **Dev** | n/a | Run the daily cron twice in a row on the local stack. | Snapshots written once, one batch audit row per run, the second run adds no duplicates. | |
| 5C-2 | Admin | Desktop | Press **Send weekly report now** twice. | The first sends. The second says it was already sent this week. One send audit row. | |
| 5C-3 | Manager | Desktop | Create two overlapping allocations so a clash appears, then fix one. | The clash is created, then resolved. One audit row for each. | |

### 5D. Blocker reason, ETA, last sign-in

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 5D-1 | Manager | Phone 390 px | Create a task with only a name. | It saves. The two new fields are optional and empty. | |
| 5D-2 | Manager | Phone 390 px | Edit the task, set **Blocker reason** and **ETA**. | Both save and show on the detail. The fields stack with no horizontal scroll. | |
| 5D-3 | Manager | Desktop | Set a blocker reason with no blocked-by task, then a blocked-by with no reason. | Both are accepted. | |
| 5D-4 | Manager | Desktop | Edit the same fields on a task of a locked project. | Refused, like any other task edit on a locked project. | |
| 5D-5 | Tester | Desktop | Read the task list through a token, lean view. | `blocker_reason` and `eta` appear only on tasks where they are set. | |
| 5D-6 | Admin | Desktop | Export the members CSV. | A `last_sign_in_at` column exists. A member who never signed in has an empty cell. | |
| 5D-7 | Manager | Desktop | Export the members CSV. | There is no `last_sign_in_at` column. | |

## Wave 2: external anchor, agent evidence tools, deletion of the other registers

### 5E. Audit anchor

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 5E-1 | Admin | Desktop, then Phone 390 px | With `NOPM_ANCHOR_DB_URL` unset, open the Trust Center. | It says **not anchored** with one line on how to turn it on. Not green. Readable at 390 px. | |
| 5E-2 | **Dev** | n/a | Set the variable to the second local database and restart the dev server. | n/a | |
| 5E-3 | Admin | Desktop | Press **Verify now**. | The line reads "anchored <time> (n rows)". | |
| 5E-4 | **Dev** | n/a | Read the anchor table in the second database with SQL. | One row with the same chain_seq and head hash the Trust Center shows. | |
| 5E-5 | Manager | Desktop | Make several changes, then (admin) run the daily cron or **Verify now** again. | The anchor moves forward. A quiet day adds no second row for the same head. | |
| 5E-6 | **Dev** | n/a | On a throwaway workspace, delete the newest audit rows (rolled back after) and verify. | The Trust Center shows a red **anchor mismatch**. An `audit.anchor_mismatch` row appears. | |
| 5E-7 | **Dev** | n/a | Stop the second database container. Press **Verify now**. | An amber **anchor unreachable** line. The verify never says all clear. Business writes (create a task) still work. Exactly one `audit.anchor_failed` row. | |
| 5E-8 | **Dev** | n/a | Start the container again and verify. | The state returns to anchored. The failure streak is cleared. | |
| 5E-9 | Member | Desktop | Open the Trust Center. | The anchor line may show. There is no force-anchor control. | |

### 5F. Agent evidence tools (MCP or curl with a token)

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 5F-1 | Tester | Desktop | Call `attach_evidence` on an approved change request with a test result and tester. | The evidence shows on the change request's evidence panel for a person. One audit row. | |
| 5F-2 | Tester | Desktop | Call `create_document` with evidence fields and a change request id. | The document appears under that change request. | |
| 5F-3 | Tester | Desktop | Call `implement_change_request` on an approved request, then on a request still waiting. | The first stamps the implemented date. The second is refused with the rule's message. | |
| 5F-4 | Tester | Desktop | Call `create_decision` with a change request id. | The decision links to the change request. | |
| 5F-5 | Tester | Desktop | Call `list_rebaselines`, `get_baseline_history`, `list_documents`, `list_project_dependencies`. | Each returns lean data by default and the full view on request. | |
| 5F-6 | Tester | Desktop | Call `create_task` and `update_task` with a blocker reason and an ETA. | Both save. | |
| 5F-7 | Tester | Desktop | Use a token that lacks the decide scope to raise an emergency change request. | Refused with 403, as in cycle 2. | |

### 5G. Deletion of programs, sprints, resources, allocations, clashes

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 5G-1 | Manager | Phone 390 px | Open a test sprint and press **Request deletion** with a reason. | The sprint stays, with a "Deletion requested" chip and a **Withdraw request** button for you. No overflow. | |
| 5G-2 | Manager | Desktop | Repeat on a resource, an allocation, a clash and a program. | Same result on each. | |
| 5G-3 | Manager (second person) | Desktop | Open **Approvals**. Find the five requests. Read what approving removes. | Each shows the record, the reason and the child count where one exists. | |
| 5G-4 | Manager | Desktop | Approve the sprint request. | The sprint is gone. One audit row for the commit. | |
| 5G-5 | Manager | Desktop | Approve the program request. | Refused: a program needs an admin (per D15 default). | |
| 5G-6 | Admin | Desktop | Approve the program request. | The program is removed. Its projects remain. | |
| 5G-7 | Manager | Desktop | Request deletion of a resource that has open allocations, then add another allocation, then approve. | The approval is refused as stale (the child count changed). | |
| 5G-8 | Tester | Desktop | Send `DELETE` on each of the five addresses with a member's token. | 403 for members. For others 202 with a request id. Nothing is deleted. | |
| 5G-9 | **Dev** | n/a | Run the register probe (raw `DELETE` on each table). | Each raw delete fails with the "needs request" error. A project deletion commit still cascades. | |
| 5G-10 | Tester | Desktop | Call `request_sprint_deletion` through MCP. | Same as 5G-1. | |

## Wave 3: cleanup, documents, live checklist

| Step | Role | Device | Do | Expect | Pass/Fail |
|---|---|---|---|---|---|
| 5H-1 | Admin | Desktop | Open **Settings**, Approval policy, Emergency row. | The help text says "Commits when raised. No approval. Flagged everywhere." No retro wording anywhere in settings. | |
| 5H-2 | Admin | Desktop | Export the audit pack CSV. | The header keeps `is_emergency` and a blank `retro_overdue` column. | |
| 5H-3 | **Dev** | n/a | Log in with each seed login. | Seed logins use `@example.com`. | |
| 5H-4 | Admin | Desktop | Open `/api/openapi.json` and `/llms.txt`. | The new routes and fields are listed. | |
| 5H-5 | Owner | Desktop | Open `CUTOVER/12-POST-RELEASE-CHECKS.md` and read the first block. | It is plain SQL, says it only reads, and says what a good result looks like. No command in it changes data. | |
| 5H-6 | **Dev** | n/a | Run the local rehearsal script for migrations 0107 to 0112 twice. | Second run changes nothing. Row counts before and after match. | |

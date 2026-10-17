# How governance works

This is the "why NoPM is different" chapter. Every idea here is enforced by the database and the API, not just suggested by the interface. That distinction matters most when an AI agent, not a person, is the one making the changes: a UI warning is easy for an agent (or a careless click) to route around, but a database rule is not.

**In one sentence:** NoPM assumes that anyone with access, human or AI, will eventually make a mistake or push their luck, and builds the safety net into the same layer that stores the data, rather than into the screen the mistake was made on.

## The audit log

**What it is:** every single change made in NoPM, whether creating a task, moving a card on the board, minting a token, or approving a deletion, writes exactly one permanent row to a table called `audit_log`. The row records who did it, what they did, what it was done to, and when. Rows can never be edited or deleted, even by an administrator. The database itself blocks that at the storage layer, not just in the app's code.

**Example:** an AI agent connected over MCP drags a task from "In Progress" to "Done." That single drag produces one `task.update` row in the audit log, showing the agent's token as the actor, the old status and the new status, and a timestamp. Nothing about that write can quietly disappear later.

**Where you see it:** the **Trust Center** (`/trust`), covered below.

## Scopes: an agent only gets what you explicitly grant

**What it is:** every access token is issued with a specific list of **scopes**, written as `resource:action` (for example, `task:write` or `budget:read`). An endpoint checks the caller's scopes before doing anything; a token without the right scope gets a clear `403 Forbidden` response, not silent partial access.

**Example:** if you mint a token with only `project:read` and `task:read`, and then ask an AI agent connected with that token to create a task, the request fails outright. The agent cannot create anything, because its token was never given the `task:write` scope. This is why NoPM ships a "least-privilege agent preset" when you connect an agent: read access to everything, plus the ability to edit tasks, and nothing that can delete, approve, or manage other tokens.

## Four-eyes (maker-checker) approval

**What it is:** for the two most destructive actions in the system, deleting a task and deleting a project, one person (or agent) can only ever *request* the deletion. A second, different person must separately approve it before anything is actually removed. A token counts as the person who minted it. The database has a hard rule, not just an app-level check, that the approver cannot be the same person as the requester.

**Example:** an agent asks to delete a task. NoPM does not delete it. It snapshots the task and creates a pending "deletion request," returning a `202 Accepted` response, meaning "request received, not yet acted on." The task still exists. Someone else, a teammate or a token a teammate minted, has to open the Approvals page (or call the approve endpoint) to actually commit the deletion. If the same person tries to approve their own request, through a session or a token they minted, the server rejects it, even if that token somehow held the right scope.

Milestones, risks, and issues are deleted immediately with just an audit row; they are not part of this four-eyes flow. That's a deliberate, documented trade-off (only the two riskiest object types get the extra ceremony), not an oversight.

## Change control

**What it is:** a formal register for proposed changes to a project's scope, schedule, or cost. Raising a change and deciding on it are two different scopes (`change:write` to raise, `change:decide` to decide), and, like deletions, the person who decides on a change request cannot be the same person who raised it (a token counts as the person who minted it).

**Example:** a project stakeholder raises a change request: "add two weeks and $10,000 for an extra integration." That request sits in "under review" status and shows up in the workspace's Review Queue until someone else evaluates the schedule and cost impact and records a decision with their rationale. The whole exchange, raise, review, decide, is one traceable record, not an email thread that disappears.

## Locking and rebaselining

**What it is:** once a project's plan is approved, you can **lock** it. Locking freezes the *schedule shape*, meaning start dates, due dates, and which milestone or project a task belongs to, while leaving day-to-day work fully editable: you can still move cards on the board, update completion percentage, and change descriptions.

**Example:** a locked project's task has its due date pushed back by a well-meaning agent. The write is rejected with a clear `422` error and the code `project_locked`, telling the caller to either ask an admin to unlock the project or propose a formal **rebaseline** instead. A rebaseline is a proposed new schedule that goes through its own sign-off before it's applied, so a locked plan can still change, but only through a reviewed process, never by a stray edit slipping through. Even attempts that get blocked are written to the audit log, so a pattern of "someone kept trying to edit a locked schedule" is visible, not silently swallowed.

## The Trust Center

**What it is:** the workspace-wide screen (`/trust`) where all of the above becomes visible in one place: a live, filterable stream of the newest audit rows, color-coded by action (creates, approvals, rejections, deletions), each showing the actor, the target, and the timestamp. You can filter by channel (for example, `mcp` to see only what an AI agent did through the Model Context Protocol, versus `cli` or the web app itself), by action, or by a specific object.

A "What this proves" card on the page states plainly what a reviewer usually wants confirmed: rows are kept forever and cannot be changed, every row carries who did it and how, deletion and invite actions record their audit row in the very same database transaction as the change itself (so there is no window where a change could exist without its record), and, as a final proof point, even exporting the audit log is itself an audited action.

## Scoped credentials for AI specifically

The BYOK (bring your own key) assistant deserves a specific mention here, because it's the clearest example of the pattern. When you paste your own OpenAI, Anthropic, Google, or OpenRouter API key into NoPM's in-app assistant panel, that key is encrypted at rest and never handed to the model provider by NoPM directly to act on your workspace. Instead, the assistant mints a fresh, narrowly scoped token for itself at the start of each conversation turn, uses it to call the same governed REST API everything else uses, and that token expires. Even if the assistant were somehow tricked (by a malicious prompt inside a task description it read, for example) into trying to do something destructive, it's working with a token that was never issued the scopes needed to approve a deletion or manage other tokens in the first place. That ceiling is checked automatically by the test suite, not just claimed in documentation.

## Blocked attempts are recorded too

Governance in NoPM does not just stop bad actions silently. It records the *attempt*, not only the successful writes. Two categories of rejected request still produce an audit row: a write blocked by a project lock (for example, `task.update.blocked`), and a request rejected for exceeding the rate limit (`rate.limited`). This matters because a pattern of repeated denied attempts, an agent hammering a locked schedule, or a script retrying past its budget, is a signal worth seeing, not something that should vanish just because it didn't succeed. The Trust Center shows these rejected-attempt rows in the same stream as everything else, distinguished by their outcome, not hidden from it.

## What a governance failure actually looks like to a caller

None of these rules fail silently. A blocked write returns a `422` status with a specific error code (`project_locked`, for example) and a message that tells the caller what to do instead, ask an admin to unlock the project, or propose a rebaseline. A missing scope returns a `403`. A self-approval attempt returns a `403` or `422` depending on which check catches it first. An AI agent calling the API gets these as ordinary, parseable error responses, including through the MCP tool interface, where a scope failure comes back as the tool's result rather than being swallowed as a connection error. That matters in practice: it means an agent (or the person reading its output) can see exactly why something didn't happen, instead of just observing that it didn't.

## A summary table

| Mechanism | Applies to | What it enforces |
|---|---|---|
| Audit log | Every mutation | One permanent, unchangeable row per write |
| Scopes | Every API call | A token can only do what it was explicitly granted |
| Four-eyes | Task and project deletion | Requester and approver must be different people |
| Change control | Scope/schedule/cost changes | Raiser and decider must be different people |
| Project lock + rebaseline | Locked projects' schedule fields | Schedule changes only through a reviewed rebaseline |
| Trust Center | All of the above | A single place to see every action, successful or blocked |

## Why this matters for an AI agent specifically

An AI agent acting on your behalf is fast and can make many changes in a short time. Governance built into the data layer means you never have to trust the agent's judgment alone to avoid catastrophe: even if you gave it a broad set of scopes and asked it to "clean up the old tasks," the four-eyes rule means it can propose deletions all day, but a different person (or a token that person minted) still has to sign off before anything is actually gone. That is the core idea behind NoPM's whole design.

# ADR 0014 — Approver roles: only admins and managers decide

- **Status:** Accepted (owner decision 16, 2026-10-17: "follow Lark rules")
- **Date:** 2026-10-17
- **Builds on:** ADR 0006 (atomic deletion), ADR 0012 (integration hub), ADR 0013 (principal-aware four-eyes)
- **Resolves:** backlog decision 6 ("who may approve")

## Context

ADR 0013 made four-eyes compare **people**: the person who raised a request can never decide it. It did not say **which** people may decide. In practice any signed-in user whose role carried the exact approve scope could, and a token carried that scope for whoever minted it. The Lark integration (ADR 0012) had already answered the question for chat: only an admin or a manager may approve or reject from a card, and a member who taps the button is told "Only managers and admins can approve or reject from chat."

That left two rules for one act. A member refused in chat could open the console, or mint a token, and decide the same request there. The journey audit of 2026-10-17 listed this as the largest remaining gap between what the documents promised and what the code did. The `llms.txt` claim that "agents never approve" was also an overstatement: a token created by a manager and carrying an approve scope *could* decide, and nothing told the agent so.

## Decision

### D1 — One rule on every channel

Approving or deciding is for **admins and managers only**, whatever the channel (console, REST, CLI, MCP, chat card). The decide verbs are:

- project and task deletion: approve, reject
- change request: decide (approve, reject, defer)
- rebaseline: sign-off (go / no go) and apply
- timesheet: approve, reject, reopen (removed 2026-10-17, decision 18)

A member or viewer gets 403 with code `role_not_permitted` and the message "Only managers and admins can approve".

### D2 — A token is judged by its creator's current role

For a session, the role is the signed-in user's own. For a token, it is the **current** role of the person who minted it (`api_tokens.created_by`, resolved onto the actor as `principalRole`). Consequences:

- A member cannot approve by minting a token.
- A manager who is demoted stops approving at once, through every token they hold, without revoking anything.
- A token whose creator is unknown has no role and is refused (fail-closed), matching the no-owner rule of ADR 0013.
- A personal access token that carries an approve scope is therefore a manager's delegated authority. Four-eyes still holds (a token never decides what its creator raised), and a wildcard still never grants the scope (R-96).

### D3 — Enforce it twice

The route layer calls `requireApprover(actor)` in every decide verb, next to the scope check. The database repeats the rule with errcode P0018: a trigger on `deletion_requests` (migration 0061, so it survives later redefinitions of the commit functions) and approver checks inside the rebaseline sign-off, rebaseline apply and change-request decision RPCs (migrations 0062 and 0063). A new route, a script or a direct service-role session cannot skip it for those verbs. Timesheet decisions are guarded in the route only. The console hides the controls from members and viewers, but the API stays the authority.

### D4 — Agents may help, but do not hold the decision

The in-app assistant never holds an approve or decide scope and has no approve tool. The MCP server offers `sign_off_rebaseline` and `apply_rebaseline`, which call the same routes with the caller's own token; they succeed only if that token carries `rebaseline:approve` and its creator is currently an admin or manager. `llms.txt` and the OpenAPI description say so plainly.

## Consequences

- A small workspace with one admin and members only has one person who can approve; that person still cannot approve what they raised themselves (ADR 0013). The owner accepted this in decision 16.
- Role changes take effect immediately for token approvals, which is what we want, and is a reason to treat an approve-scoped token like a manager's credential: revoke it when the manager leaves (see the leaver procedure in `docs/runbooks/user-provisioning.md`).
- Time entries follow a related, narrower rule (decision 17, to be confirmed by the owner): a member logs, edits and deletes only their own hours; admins and managers may do it for others (`not_your_hours`).
- Unlock stays a single-person act (decision 7) and is not an approval verb; it is governed by `project:write` and a required reason.
- Requirements: R-113. Use cases: UC-08, UC-10, UC-11, UC-12, UC-17, UC-19, UC-23.

## Alternatives considered

- **Keep scope-only gating and document it.** Rejected: two different answers to "may a member approve?" depending on the channel is the defect.
- **A separate `approver` role.** Rejected for now: the owner chose to reuse the existing roles ("follow Lark rules"); a new role can be added later without changing this rule's shape.
- **Judge a token by the role its creator had when it was minted.** Rejected: a demotion would not take effect, and a leaver's old tokens would keep approving.

> **Update 2026-10-17 (owner decision 18):** the timesheet verbs (approve, reject, reopen) and decision 17 (members log only their own hours, `not_your_hours`) are moot: hour logging was removed. The approver rule stands for deletions, change requests and rebaselines.

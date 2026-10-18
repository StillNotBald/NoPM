# UC-34 · Task status from GitHub work events

**Goal:** A task moves when its pull request opens or merges, or when its deployment succeeds or fails, without anyone typing the new status. The Kanban board then tells the truth about delivery, and the audit trail shows which GitHub delivery moved which task (audit gap A1).

**Actors:** Admin (connects the repository webhook, changes the status mapping, rotates the secret, or revokes the connection). Project manager or team member (links a pull request to a task). Any signed-in member (reads the connection and the recent events). GitHub (calls the webhook; it is not an agent).

**Preconditions:** Migration 0105 is applied before the build serves traffic. It is additive and has no backfill. After release, an admin creates the connector.

**Trigger:** A team opens a pull request for a task, merges it, or ships to an environment.

## Main flow

1. An admin opens **Integrations** and the GitHub card. The card shows whether a connection exists, its webhook address, the status each event moves a task to, and the last 20 events.
2. The admin selects **Connect**. The card shows the webhook address and the secret once. The admin copies both.
3. In the GitHub repository, the admin adds a webhook with that address and secret. Content type is `application/json`. Events are Pull requests and Deployment statuses.
4. On a task, the person opens the detail panel and types the pull request into **Link PR**, as `owner/repo#number` or as the pull request's web address. The field stores `github:owner/repo#number` with source `github`.
5. The pull request is opened. GitHub delivers the event. NoPM matches the reference to the task and moves it to the mapped status, if the task is not already further on.
6. The pull request is merged. The task moves to its mapped status. A deployment that succeeds moves the task to completed.
7. The card's event list shows each delivery, what it did, and whether it was applied.

## Default mapping

| Event | Default task status |
|---|---|
| Pull request opened | Started |
| Pull request merged | In review |
| Pull request closed without merge | No move |
| Deployment succeeded | Completed |
| Deployment failed | No move |

The admin can change any row on the card. Setting a row to no move stops that event from moving the task.

## Alternate and exception flows

- **The task is on a locked project** → the event is recorded as `project_locked`. No task moves. One `work_event.skipped` audit row is written.
- **No task carries the reference** → recorded as `unknown_ref`. Nothing changes.
- **The task is already at or past the mapped status** → `already_at_or_beyond`. A task never moves backwards, and never leaves completed or canceled.
- **The task was edited while the move was applied** → `conflict`. Nothing is written, so a lost race changes nothing.
- **The same GitHub delivery arrives twice** → the second answer is 200, and nothing changes.
- **The connection is paused** → every delivery is refused with a generic 401. GitHub shows those deliveries as failed, and they can be redelivered from GitHub after the connection is resumed.
- **A signature that does not match** → 401. Failed attempts are counted and rate-limited.
- **The connection is revoked** → the webhook stops answering. Connect again to resume.
- **A second connection while one is live** → `422` `connector_exists`.

## Postconditions

- Each applied move writes exactly one `task.update` audit row, with channel `github`, the connector as the actor, the delivery id and the GitHub login.
- Each skipped event writes `work_event.skipped` when a rule or a lock stopped it.
- Changing the mapping writes `work_event_rules.update`. Connecting, pausing and revoking write `integration.connector.*` rows.

## Evidence produced

- One row per delivery per pull request in the work-event ledger, with the reason it applied or was skipped.
- The task's audit trail, which names the GitHub delivery.

## API calls

- `POST /api/integrations/github/connector` (admin session): connect. The response carries the secret once.
- `PATCH /api/integrations/github/connector` (admin session): pause or resume, change the mapping, or rotate the secret.
- `DELETE /api/integrations/github/connector` (admin session): revoke.
- `GET /api/integrations/github/connector` (session): the connection, the mapping, and what the caller may manage.
- `GET /api/integrations/github/work-events` (session): the last events and their reasons.
- `PATCH /api/tasks/{id}` (scope `task:write`) with `external_ref` and `source` links a pull request. No new tool is needed; an agent uses the existing task update.
- `POST /api/integrations/github/{connectorId}/events`: the webhook. GitHub calls it, signed with `X-Hub-Signature-256`.

## Reporting and evidence

- The Integrations page shows the card. Members see the connection and its status. Only admins see the secret and the controls.
- The audit log can be filtered to channel `github`, to see every task moved by GitHub.

## Traceability

- R-IDs: R-153 (task status pulled from GitHub work events, audit gap A1).
- Key files: `web/supabase/migrations/20261018000105_github_work_events.sql`, `web/src/app/api/integrations/github/[connectorId]/events/route.ts`, `web/src/app/api/integrations/github/connector/route.ts`, `web/src/app/api/integrations/github/work-events/route.ts`, `web/src/lib/work/apply-task-status.ts`, `web/src/lib/integrations/github/process.ts`, `web/src/components/integrations/github-card.tsx`, `web/src/components/integrations/link-pr-field.tsx`.

## Open questions

- The work-event ledger has no retention job yet. It grows with each delivery until one is added.
- A reference matches only when its capitals match what GitHub reports, or when it is in lower case. The Link PR field always stores lower case.

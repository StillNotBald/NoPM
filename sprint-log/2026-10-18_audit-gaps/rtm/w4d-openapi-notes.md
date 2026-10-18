# W4-D OpenAPI and llms.txt notes (for the docs agent)

Four new paths. Tag: Integrations. All answer the standard `{ data }` / `{ error }` envelope except the webhook, which answers GitHub's contract.

## POST /api/integrations/github/{connectorId}/events (public, no auth)

- Path parameter `connectorId` (uuid). Headers: `X-Hub-Signature-256` (`sha256=` + hex HMAC-SHA256 of the raw body), `X-GitHub-Event`, `X-GitHub-Delivery`.
- Body: GitHub `pull_request` or `deployment_status` payload. `ping` and any other event answer 200 and change nothing.
- Responses: 200 `{ ok: true }`; 400 `{ error: "bad_request" }` (signed but no delivery id, or unreadable JSON); 401 `{ error: "unauthorized" }` (bad or missing signature, unknown, paused or revoked connector); 404 (malformed connector id); 413; 429 (`Retry-After`); 503 (nothing recorded, safe to redeliver).
- Description: moves the task whose `external_ref` equals `github:<owner>/<repo>#<number>` per the workspace mapping, never on a locked project, as a connector actor. Replays of the same delivery id are 200 and change nothing.
- llms.txt: list under Integrations as a webhook, not an agent-callable route.

## GET /api/integrations/github/connector (session only; token gets 403)

- 200 `data`: `{ connector: null | { id, name, status, webhook_url, created_at, updated_at } (members see only { name, status }), can_manage, rules, rule_targets, work_events }`. `rules` is `{ pr_opened, pr_merged, pr_closed, deploy_success, deploy_failure }`, each `unstarted | started | in_review | completed | canceled | null`.

## POST /api/integrations/github/connector (admin session)

- Body `{ name?: string (1-100) }`. 201 `data`: the connector view plus `webhook_secret` (shown once). 422 `connector_exists` when a live connector exists; 403 for non-admins and tokens; 503 `encryption_unavailable`.

## PATCH /api/integrations/github/connector (admin session)

- Body, any subset, at least one: `status` (`active | paused`), `rules` (object of event to status or null), `rotate_secret` (`true`). 200 `data`: `{ connector, rules, webhook_secret? }` (`webhook_secret` only on rotate). 422 on an unknown field, event or status; 404 when changing the connector and none exists.
- Audit actions: `integration.connector.update`, `work_event_rules.update`.

## DELETE /api/integrations/github/connector (admin session)

- Revokes the live connector. 200 `data`: the revoked connector view. 404 when none; audit `integration.connector.revoke`.

## GET /api/integrations/github/work-events (session only)

- Query `limit` 1-50 (default 20). 200 list of `{ id, kind, ref, actor_login, task_id, received_at, applied, applied_status, reason }`, newest first, workspace-filtered. `kind`: `pr_opened | pr_merged | pr_closed | deploy_success | deploy_failure`. `reason`: `received | applied | project_locked | unknown_ref | no_rule | already_at_or_beyond | task_canceled | conflict | no_linked_pr | error`.

## Other contract changes

- Audit `channel` filter and values gain `github` (`GET /api/audit?channel=github`).
- `PATCH /api/tasks/{id}`: no schema change; `external_ref` of the form `github:owner/repo#N` with `source: "github"` is what links a pull request.
- New audit actions: `work_event.skipped`, `work_event_rules.update`, `integration.connector.update`, `integration.connector.revoke`.
- Tool note: no MCP tool needed; an agent links a pull request with the existing `update_task` (`external_ref`, `source`).

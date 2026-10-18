# GET /api/export

Governed CSV export. One audit row (`export.csv`, with the entity, row count and filters) is written for every download.

## Entities

| entity | who can export | notes |
|---|---|---|
| tasks, risks, issues, clashes, audit, programs, projects | token or session holding the entity's read scope (`task:read`, `risk:read`, ...) | filters mirror each list API |
| members | admin or manager **session** only | profile, role, status, `mfa_enabled`, `removed_at`, last role change (from audit). Same audience and email field as `GET /api/members`. |
| tokens | admin or manager **session** only | `label`, `prefix`, `scopes`, creator, `expires_at`, `revoked`, `last_used_at`. Never the token hash. The assistant's per-turn tokens are hidden, as in the tokens list. There is no `revoked_at` column, only the `revoked` flag. |
| identities | admin or manager **session** only | chat-connector links: profile, provider, `linked_at`, `revoked_at`. The external platform user id is not exported. |

A token, a member or a viewer gets 403 on `members`, `tokens` and `identities`, whatever scopes the token carries.

## Date range (every entity)

- `from` and `to` are UTC calendar days, both inclusive (`YYYY-MM-DD`). A malformed day is ignored.
- By default the range filters on `created_at`. Add `on=updated` to filter on `updated_at` for entities that have one (tasks, risks, issues, clashes, projects). Other entities keep their creation column (`linked_at` for identities).
- The range is recorded in the `export.csv` audit row.

## Audit CSV columns

`id, workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, created_at, principal_id, principal_label, via_connector_id, external_event_id, external_actor_ref`

`principal_id` is the accountable person behind a token or connector action. `principal_label` is resolved from profiles in one query per export (blank when the person is unknown or it is a system action).

## Cap

At most 10,000 rows. If more match, the last line is `# TRUNCATED: showing N of M matching rows (cap 10000)` and a server warning is logged. Narrow with `from` / `to`.

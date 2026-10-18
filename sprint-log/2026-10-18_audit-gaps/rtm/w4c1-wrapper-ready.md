# W4-C1 wrapper ready (for W4-C2)

Migration `web/supabase/migrations/20261018000103_mutate_audited.sql` and the wrapper `web/src/lib/audit/audited-write.ts` exist and their tests pass (`src/lib/audit`: 122 tests).

## RPC

```
nopm_mutate_audited(
  p_table text, p_op text,            -- 'insert' | 'update' | 'delete'
  p_workspace_id uuid, p_id uuid,     -- p_id null on insert (or a client-chosen id)
  p_patch jsonb,                      -- columns to write; id / workspace_id / created_at refused
  p_expected_updated_at timestamptz,  -- optimistic concurrency, null = off
  p_audit jsonb                       -- action, target_type, actor_*, principal_id, channel, request_id, via_connector_id, external_*
) returns jsonb                       -- { before, after }
```

Allowlist: projects, milestones, tasks, risks, issues, clashes, programs, sprints, allocations, expenses, resource_members, saved_views, calendar_feeds, documents, decisions, invites, api_tokens, notifications, integration_connectors, external_identities, assistant_credentials, project_budget, profiles, plus project_dependencies and task_dependencies (added by W4-C1 for the dependency routes). A table outside it needs a new migration (and the same edit to `AUDITED_TABLES`; a test checks the two lists agree). Single-row writes only: a handler that writes several tables keeps its own path.

## Wrapper

```ts
import { auditedInsert, auditedUpdate, auditedDelete } from "@/lib/audit/audited-write";

const row = await auditedInsert({ table, actor, action: "x.create", patch, id? });                // -> after row
const { before, after } = await auditedUpdate({ table, actor, action: "x.update", id, patch,
  expectedUpdatedAt?, notFoundMessage? });                                                          // 404 / 412 mapped
const gone = await auditedDelete({ table, actor, action: "x.delete", id, expectedUpdatedAt? });   // -> before row
```

- `before` and `after` in the audit row are the real rows read and written inside the transaction. Do not pass them and do not call `writeAudit` for the same mutation.
- Optional audit controls on every call (all affect the audit row only, never the stored row):
  - `omitColumns: ["token_hash", ...]` keeps secret-bearing columns out of the audit row AND out of the rows the call returns (the column is still written). Use it for api_tokens, invites, assistant_credentials, calendar_feeds.
  - `afterExtra: {...}` merges extra keys into the audited "after" (e.g. a warning the caller acknowledged).
  - `auditBefore` / `auditAfter` replace what the audit row records (pass `null` for SQL null) and `auditTargetId` + `targetType` re-aim it, for events that are not "this row changed" (sprint started, task attached to a sprint, dependency added to a project).
  - `requireNull: "revoked_at"` is a compare-and-set: the row must still have that column NULL, else 412 (map it to the handler's own 422).
- `workspaceId` defaults to `actor.workspaceId`; `targetType` defaults to the singular table name.
- Errors: `NOT_FOUND` -> `NotFoundError(notFoundMessage)`, `STALE_ROW` -> `PreconditionFailedError`, `UNKNOWN_COLUMN` and friends -> logged, generic 500. Any other database error (23505, 23503, trigger raises) is rethrown as the original object, so `error.code === "23505"` checks in handlers keep working.
- A handler that wants the 412 body to carry `current_updated_at` still runs `checkOptimisticConcurrency(existing.updated_at, expected)` first, then passes `expectedUpdatedAt` so the RPC closes the race.
- Keep sending `updated_at` in the patch where the handler did before (the RPC does not stamp it).

## Tests

`FakeDb` (`src/lib/governance/test-support/fake-admin.ts`) now answers `nopm_mutate_audited` through `fake-mutate-audited.ts`: it writes the row and exactly one `audit_log` row, maps the same errors, and `db.mutateFailure = { code, message }` makes the next call fail with nothing written. Route tests that used a hand-rolled admin mock need an `rpc` for this name or should switch to `FakeDb`.

Coverage scan (`src/lib/audit/coverage.test.ts`) treats a call to `auditedInsert/Update/Delete` as audited, same as `writeAudit(` or an auditing RPC.

## Update (W4-C1)

- `project_budget` is keyed on `project_id`: pass its project id as `id` for update and delete and as the optional `id` on insert; do not put `project_id` in the patch (refused).
- The RPC now accepts channel `github`.

## Update 2 (W4-C1 fix pass)

- The allowlist is now a table, `nopm_mutate_audited_tables` (key column, workspace column, insert columns, update columns). Add or narrow a table with `insert ... on conflict (table_name) do update` in your own migration; never recreate the function. W4-A: `workspaces` is `(table_name, key_column, workspace_column) = (workspaces, id, id)` plus an `update_columns` list.
- Narrowed on update: profiles (display_name, avatar_url), api_tokens (label, revoked, revoked_at, expires_at, last_used_at), invites (revoked, revoked_at, expires_at, renewed_at, status), assistant_credentials (provider, model, api_key_enc, updated_at; so no user_id in a replace patch). profiles cannot be inserted.
- An expected_updated_at pin on a table with no updated_at raises NO_UPDATED_AT (generic 500 plus a log).
- p_audit is trusted input.
- Error codes are now P0051 to P0056.

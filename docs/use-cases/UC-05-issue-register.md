# UC-05 · Issue register: log, triage, resolve

**Goal:** Record a live problem affecting a project (as distinct from a forward-looking risk), triage its priority, and track it to resolution.

**Actors:** Team member, Project Manager. AI agent via token with `issue:read` / `issue:write`.

**Preconditions:** A project exists.

**Trigger:** Something has already gone wrong (as opposed to a risk, which is a threat that hasn't happened yet).

## Main flow

1. UI: `/projects/[id]` → Issues tab (or the cross-workspace Issues register). POST via `POST /api/projects/{id}/issues` (scope `issue:write`). Required: `title`, `priority` (`low|medium|high|urgent`). Optional `severity` (`low|medium|high|critical`), `status` defaults `open` (`open|in_progress|resolved|closed`), `resolution_eta`/`resolved_at` as `YYYY-MM-DD`.
2. MCP: `create_issue`/`update_issue`/`list_issues` tools, scopes `issue:write`/`issue:read`.
3. Move the issue through its lifecycle with `PATCH /api/issues/{id}`: `open → in_progress → resolved → closed`.
4. `source`/`external_ref` (R-81) let an issue mirror an upstream Jira/Slack/Teams ticket without syncing to it; `GET /api/projects/{id}/issues` supports exact-match `?source`/`?external_ref` filters.

## Alternate and exception flows

- **Missing `title`/`priority`** → `422`.
- **Invalid enum value for `priority`/`severity`/`status`** → `422`.
- **Missing `issue:write`** → `403`.
- **Delete** — `DELETE /api/issues/{id}` (scope `issue:write`) is a plain hard delete with an audit row only, not maker-checker (R-67's four-eyes extension covers task and project deletion only).
- **Role-gated empty state** — a viewer or non-write role landing on the Issues register with zero issues sees a role-aware empty state explaining who can create one, rather than a raw permission error or a misleading "no data" message (R-70).

## Postconditions

- One `issue.create` audit row on creation; one `issue.update` per PATCH; one `issue.delete` on delete.
- No Review Queue surfacing rule specific to issues was found; unlike risks, issues do not automatically enter `/review` by severity `[UNVERIFIED]` — `web/src/lib/review/gather.ts`'s documented sources are deletion requests, rebaselines, documents in review, high/critical risks, and open clashes, with no issues source listed.

## Reporting and evidence

- `GET /api/export?entity=issues` (scope `issue:read`) requires `project_id`, supports `status`/`severity`/`priority`/`sort`.
- Global search indexes issues.
- "History" deep-link on the issue detail header jumps to `/trust?target_type=issue&target_id=<id>`.

## Traceability

- R-IDs: R-14 (Issue register), R-81 (external reference seam), R-70 (role-aware empty states).
- Key files: `web/src/app/api/issues/route.ts`, `web/src/app/api/issues/[id]/route.ts`, `web/src/app/api/issues/_schema.ts`, `web/src/components/registers/issue-detail.tsx`, `web/src/app/(console)/issues/page.tsx`.
- Tests: `[UNVERIFIED]` no issue-specific test file was read directly.

## Open questions

- `[UNVERIFIED]` Whether issues ever surface in the Review Queue under any condition; the documented `gather.ts` source list does not include an issue-severity rule the way it does for risks.

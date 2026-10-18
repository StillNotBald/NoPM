# UC-04 · Risk register: raise, mitigate, close

**Goal:** Record a project risk, track its severity and likelihood, and move it through mitigation to closure, with the register visible enough that high/critical risks surface to reviewers automatically.

**Actors:** Project Manager, Team member. AI agent via token with `risk:read` / `risk:write`.

**Preconditions:** A project exists.

**Trigger:** A Project Manager identifies a threat to the project's schedule, cost, or scope.

## Main flow

1. UI: `/projects/[id]` → Risks tab (or the cross-workspace Risks register). POST via `POST /api/projects/{id}/risks` (scope `risk:write`). Required: `title`, `severity`, `likelihood`, both from `low|medium|high|critical`. `status` defaults to `open` (`open|mitigating|closed|accepted`). `raised_at`/`due_date` are ISO 8601 datetimes with offset.
2. CLI/MCP: no dedicated CLI shown by name in `cli/README.md` beyond "risks" as one of the module command groups listed generically; MCP tools `create_risk`/`update_risk`/`list_risks`, scopes `risk:write`/`risk:read`.
3. Update the risk as mitigation proceeds: `PATCH /api/risks/{id}` (scope `risk:write`), e.g. moving `status` from `open` to `mitigating` to `closed`, or `accepted` if the risk is knowingly retained.
4. A risk with `source`/`external_ref` set (R-81) can name the upstream Jira/Slack/Teams item it mirrors; `GET /api/projects/{id}/risks` supports exact-match `?source`/`?external_ref` filters.
5. A high or critical risk that is not yet `closed`/`accepted` automatically appears in the **Review Queue** (`/review`) as a `risk` item, priority-sorted (critical first, then high, then oldest) — this happens without any separate "flag for review" action; it is computed live from the register (`web/src/lib/review/gather.ts`).

## Alternate and exception flows

- **Missing `title`/`severity`/`likelihood`** → `422` with per-field messages.
- **Invalid `severity`/`likelihood`/`status` enum value** → `422`.
- **Duplicate `(workspace_id, source, external_ref)`** → blocked by the partial unique index from R-81 migration `20260906000041_external_refs.sql`; expected `422`/constraint violation `[UNVERIFIED exact error shape for this specific unique-index collision]`.
- **Missing `risk:write`** → `403`.
- **Delete** — `DELETE /api/risks/{id}` (scope `risk:write`) is a plain, single-step hard delete with an audit row only; risks do **not** go through the four-eyes maker-checker flow (that is reserved for task and project deletion only, R-67).

## Postconditions

- One `risk.create` audit row on creation; one `risk.update` per PATCH (status transitions included); one `risk.delete` on delete.
- A high/critical open risk is visible in `/review` until it moves to `closed`/`accepted` or drops in severity.

## Reporting and evidence

- `GET /api/export?entity=risks` (scope `risk:read`) requires `project_id`, and supports `status`/`severity`/`sort` filters, reusing the list API's own parsing.
- Global search (`GET /api/search?q=`) indexes risks alongside projects, tasks, and other registers.
- The project's "History" deep-link on the risk detail header jumps to `/trust?target_type=risk&target_id=<id>` for a filtered audit slice (R-86).

## Update 2026-10-18 - common-pattern answers

- Closing a risk needs a `resolution` note (422 with `fields: [{field: "resolution"}]`: "Add a short note on how this was resolved.").
- The owner is alerted whenever severity or likelihood rises, not only when the risk is created.
- Unknown fields are refused 422 and nothing is saved.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

## Traceability

- R-IDs: R-13 (Risk register), R-81 (external reference seam), R-38 (Review Queue).
- Key files: `web/src/app/api/projects/[id]/risks/route.ts` (list + create), `web/src/app/api/risks/[id]/route.ts`, `web/src/app/api/risks/_query.ts`, `web/src/app/api/risks/_schema.ts`, `web/src/lib/review/gather.ts`, `web/src/components/registers/risk-detail.tsx`.
- Tests: `[UNVERIFIED]` no risk-specific test file was read directly; covered indirectly by the shared audit-coverage and OpenAPI-drift suites (R-60).

## Open questions

- None outstanding for the flow itself. There is no cross-project `GET /api/risks`: the cross-workspace Risks register reads server-side, which is why the CSV export requires `project_id`.

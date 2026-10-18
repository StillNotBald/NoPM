# R-90 — Optimistic concurrency control on entity PATCH

## Summary

Added opt-in optimistic concurrency control (OCC) to the five entity PATCH
routes (`projects`, `tasks`, `milestones`, `risks`, `issues`). A caller may
send `expected_updated_at` (ISO 8601 datetime, offset required) in the PATCH
body; if present, it must match the row's current `updated_at` or the write
is rejected with `412 Precondition Failed` instead of silently overwriting a
concurrent edit. Omitting the field preserves today's last-write-wins
behavior exactly — fully backward compatible, no client is required to
change.

## Files changed

- `web/src/lib/api/occ.ts` (new) — `checkOptimisticConcurrency(currentUpdatedAt, expectedUpdatedAt)`, the shared check.
- `web/src/lib/api/occ.test.ts` (new) — 9 unit tests (exact match, ms-equal microsecond strings, mismatch, missing field, malformed field, missing current value).
- `web/src/lib/api/errors.ts` — added `PreconditionFailedError` (HTTP 412, code `precondition_failed`, optional `currentUpdatedAt`); `toErrorResponse` now special-cases it to add `current_updated_at` to the `{ error }` body.
- `web/src/app/api/{projects,tasks,milestones,risks,issues}/_schema.ts` — added `expected_updated_at: z.string().datetime({ offset: true }).optional()` to each `update*Schema` (and to `TaskUpdateSchema`, which is `.strict()`, before the `.strict()` call).
- `web/src/app/api/{projects,tasks,milestones,risks,issues}/[id]/route.ts` — PATCH handlers now call `checkOptimisticConcurrency` against the already-fetched `existing`/`before` row, strip `expected_updated_at` before building the DB update, and (defense-in-depth) add `.eq("updated_at", <pre-check value>)` to the update query itself when the field was sent, switching `.single()` → `.maybeSingle()` so a lost race (zero rows matched) throws a clean `PreconditionFailedError` instead of surfacing a raw PostgREST "no rows" error as a 500.
- `web/src/app/api/openapi.json/route.ts` — added `components.responses.PreconditionFailed` (mirrors the existing `RateLimited` shared-response pattern) and referenced it as a `412` response on all five PATCH operations; request bodies pick up `expected_updated_at` automatically since they're generated from the same Zod schemas (`zodBody(...)`). Added an R-90 sentence to `info.description`.
- `web/src/app/llms.txt/route.ts` — new "Optimistic concurrency (R-90)" section explaining the field, its semantics, and the recommended agent pattern (read → keep `updated_at` → pass back as `expected_updated_at`).
- `web/mcp/tools.mjs` — added a shared `expected_updated_at` JSON-Schema fragment and added it to `update_project`, `update_task`, `update_milestone`, `update_risk`, `update_issue`. No scope changes.
- `web/src/lib/api-client.ts` — `ApiError` gained an optional `currentUpdatedAt` field, populated from `current_updated_at` on a 412 response.
- `web/src/components/forms/{project,task,milestone,risk,issue}-form.tsx` — each `Project`/`Task`/`Milestone`/`Risk`/`Issue` interface gained `updated_at?: string | null`; each edit-mode payload now includes `expected_updated_at` (the loaded record's `updated_at`) only when editing an existing record; each submit handler's catch block special-cases `status === 412` to show "This record changed since you opened it. Reload to see the latest." (top-of-form error + toast) instead of the generic API error, and does not proceed with any success path (unchanged control flow — the message replaces, it never overwrites the user's in-progress edits).
- `web/src/lib/governance/lock.test.ts` — added `expected_updated_at` to `ALLOWED_TASK_FIELDS` (a pre-existing governance invariant test asserts every `TaskUpdateSchema` field is classified as schedule-shape or allowed-under-lock; this field is neither schedule-shape nor DB-persisted, so it belongs in "allowed"). This is the one file touched outside the original scope list — required to keep `npx vitest run` green after adding the field to `TaskUpdateSchema`; flagged below under "Requests for lead."

## Semantics

- **Opt-in.** `expected_updated_at` absent or `null` → no-op, unchanged behavior.
- **Match rule.** Exact string equality (fast path — the common case of echoing back a prior response's `updated_at` verbatim) OR equal millisecond epochs via `Date.parse` (handles Postgres's microsecond-precision `timestamptz` vs. JS's millisecond-precision round-trip). A malformed `expected_updated_at`, or an unresolvable current value, is a mismatch — the check only ever fails closed.
- **Where the check runs.** Inside the existing fetch-existing-then-update flow, using the row each route already loads for its audit `before` snapshot — no extra read.
- **Defense-in-depth.** The actual `UPDATE` is additionally scoped with `.eq("updated_at", <the value just checked>)` whenever `expected_updated_at` was sent, closing the (narrow) race between the pre-check read and the write. This is not a second network round-trip — it's one more filter clause on the query already being built. On a lost race, the filter matches zero rows; the route now uses `.maybeSingle()` there and turns "no row returned" into a clean `PreconditionFailedError` rather than a raw PostgREST error surfacing as a 500. This branch doesn't have a fresh `current_updated_at` to report (no extra read was done) — the field is simply omitted from that particular 412 body, which is safe since the client's job either way is "reload and retry."
- **Audit.** Every successful PATCH still writes exactly one audit row — unchanged, `expected_updated_at` never reaches the audit `before`/`after` snapshots because it's stripped before the DB update (projects/tasks spread `parsed.data`/`input` directly, so it's destructured out; milestones/risks/issues build their `updates` object field-by-field and never reference it there, so no destructuring was needed for those three).

## 412 body example

```json
{
  "error": "Record changed since you loaded it",
  "code": "precondition_failed",
  "current_updated_at": "2026-09-07T08:12:44.031Z"
}
```

(`current_updated_at` omitted on the rare lost-race branch, as noted above.)

## Test counts

- `occ.test.ts`: 9/9 passing (exact match, ms-equal cross-precision match, real mismatch, error echoes `currentUpdatedAt`, malformed `expected_updated_at`, missing/non-string current value fails closed, error omits `currentUpdatedAt` when current is unresolvable).
- Full suite: `npx vitest run` → **1966/1967 passing**. The one failure (`openapi-coverage.test.ts` — `POST /auth/mfa/challenge` missing from the spec) is **pre-existing and unrelated**: confirmed via `git stash` that it fails identically on a clean working tree before any of this work, caused by an in-progress, untracked `src/app/api/auth/mfa/challenge/` route from a different concurrent teammate in this shared session. Not touched — outside file scope.
- `tools-zod.test.ts`: 40/40 (drift lock intact — `expected_updated_at` exists on every corresponding Zod schema, no required-field or enum drift introduced).
- `openapi-coverage.test.ts`: 143/144 (144 total; the 1 failure is the pre-existing mfa/challenge gap above, unrelated to the 5 routes touched here).
- `llms-coverage.test.ts`: 142/142.
- Audit coverage (`src/lib/audit/coverage.test.ts`): unaffected — still scans for a `writeAudit(` call per mutating route; none of the five routes lost theirs.
- `npx tsc --noEmit`: clean.
- `npx eslint` on every changed file (including `mcp/tools.mjs`): 0 errors, 0 warnings.

## Requests for lead

- **RTM text (R-90):** suggest something like: *"R-90 — Optimistic concurrency control: PATCH on projects/tasks/milestones/risks/issues accepts an optional `expected_updated_at`; a stale value is rejected with 412 instead of being silently overwritten. Opt-in and backward compatible — omitted by default today."* Acceptance criteria to cite: (1) omitting the field preserves prior behavior exactly, (2) a matching value proceeds, (3) a stale value returns 412 with `current_updated_at`, (4) documented in OpenAPI + llms.txt + MCP tool registry, (5) every PATCH still writes exactly one audit row.
- **CLI flag suggestion** (for `cli/`, which I did not touch): a `--if-match <timestamp>` flag on the update subcommands (`nopm project update`, `nopm task update`, etc.) that maps to `expected_updated_at` in the request body, likely paired with a `--force` flag to explicitly skip it. The natural companion is having `nopm <entity> get` print `updated_at` so a scripted `get | jq -r .updated_at` → `update --if-match <that>` round-trip is easy to compose. Left entirely unimplemented per the file-scope boundary.
- **`web/src/lib/governance/lock.test.ts`** — noted above: I added one line classifying the new field there because it's a hard-coded completeness check tied directly to `TaskUpdateSchema`'s field list, which I extended. Flagging in case the lead wants a different home for that classification or a different field name in the future.

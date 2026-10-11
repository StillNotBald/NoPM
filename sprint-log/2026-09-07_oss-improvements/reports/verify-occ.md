# Adversarial verification — R-90 optimistic concurrency control

Reviewed against actual code (`web/src/lib/api/occ.ts`, `errors.ts`, the five
`[id]/route.ts` PATCH handlers, `_schema.ts` files, `openapi.json/route.ts`,
`llms.txt/route.ts`, `mcp/tools.mjs`, `api-client.ts`, all five
`components/forms/*.tsx`), plus a full `npx vitest run` and `npx tsc --noEmit`.
Full suite: **88 files / 1976 tests passing, 0 failing** (better than the
report's stated 1966/1967 — the one pre-existing `openapi-coverage` failure
it flagged as unrelated has since been resolved by another concurrent
teammate's `/auth/mfa/challenge` spec entry; not this worker's doing, and not
a discrepancy in their report, which was accurate as of when they wrote it).

## Claim 1 — omitting the field is byte-identical to before

**PARTIALLY REFUTED (cosmetic, not functional).** Field-stripping is correct:
`projects/[id]/route.ts:63` and `tasks/[id]/route.ts:69` destructure
`expected_updated_at` out before the spread; milestones/risks/issues build
`updates` field-by-field and never reference it — confirmed no schema
strictness change, no extra read, no changed audit `before`/`after`.

But the query builder itself changed **unconditionally, for every caller,
whether or not `expected_updated_at` is sent**: all five routes replaced
`.select().single()` with `.select().maybeSingle()`, e.g.
`web/src/app/api/tasks/[id]/route.ts:114` (was `.single()` at the old
line 108, per `git diff`). This only matters in a vanishingly narrow race
(the row vanishes between the pre-fetch and the update, e.g. a concurrent
delete) that omitted-field callers could never previously trigger through
normal API surfaces — but it is a real difference: before, that race
produced `updateError` (a raw PostgREST "0 rows" error) and threw
`new Error(updateError.message)`; now it produces `updated === null` with no
error and throws the generic `new Error("Update failed")` (tasks/risks) or
`new Error("Update failed")`/`NotFoundError("Milestone not found")`
(projects/milestones). Same HTTP status (500, or 404 for milestones), same
"no audit written" outcome, different message text only. Not worth blocking
on — flagging only because the report's phrasing ("byte-identical … no
changes") is not literally true for this one dead-letter branch.

**Repro (conceptual, not exercised against a live DB):** two concurrent
PATCH /api/tasks/{id} calls where the second call's row disappears between
fetch and write, neither call sending `expected_updated_at`. Pre-existing
behavior: 500 with the raw PostgREST message. New behavior: 500 with
"Update failed". No test in the suite exercises this (no route.ts in
`src/app/api/{tasks,projects,milestones,risks,issues}` has an integration
test at all — `_query.test.ts`/`_schema.test.ts` only — so this is a
pre-existing gap in the codebase's test conventions, not something this
worker skipped).

## Claim 2 — millisecond-equal comparison is correct

**CONFIRMED.** Verified with live Node/V8 checks (not just reading the
code):
- Microsecond truncation is *consistent* between `Date.parse` and
  `Date.prototype.toISOString()` — both truncate (never round) to 3 digits,
  so `"...789999+00:00"` and a client's round-tripped `"...789Z"` always
  compare equal (`Date.parse` on both = `1788784496789`). No false mismatch.
- Timezone offsets normalize correctly: `"14:34:56.789+02:00"` ==
  `"12:34:56.789Z"` (both to the same epoch ms).
- `Z` vs `+00:00` are equivalent, as expected.
- Malformed strings (`"not-a-date"`, `""`) → `NaN` → correctly fail closed
  (`occ.ts:38-40`).
- `null`/`undefined` current (legacy or unresolvable) → `current = null` →
  `currentMs = NaN` → fails closed, error omits `currentUpdatedAt` — exactly
  the case `occ.test.ts`'s "throws when currentUpdatedAt is missing/non-string"
  and "does not include current_updated_at…" tests cover, and I confirmed
  those pass (`npx vitest run src/lib/api/occ.test.ts` → 9/9).

No false-pass or false-fail scenario found. This is the strongest-verified
claim in the set.

## Claim 3 — conditional UPDATE race: no false-412, no audit on lost race

**CONFIRMED**, by code structure (no live-DB race was reproduced — see gap
noted under Claim 1). In all five routes:
- The `.eq("updated_at", <pre-check value>)` clause is added only when
  `expected_updated_at !== undefined`, e.g. `projects/[id]/route.ts:79-81`.
- On a lost race, `query.select().maybeSingle()` returns `data: null,
  error: null` (zero rows matched, not a PostgREST error) — confirmed this
  is the correct `maybeSingle()` contract, not `.single()`'s throw.
- `if (!after) { if (expected_updated_at !== undefined) throw new
  PreconditionFailedError(...) }` — this throw happens **before** the
  `writeAudit(...)` call in every route (`projects/[id]/route.ts:89` audit
  call is reached only past the `!after` guard at line 84). `route()`
  (`web/src/lib/api/handler.ts:44`) wraps the handler in try/catch and calls
  only `toErrorResponse(error)` on a throw — no side effects, no audit write,
  no `notify()` call (projects' PATCH doesn't call `notify` at all; that's
  DELETE-only). Verified structurally for all 5 routes — none reaches
  `writeAudit` on the lost-race path.
- `PreconditionFailedError` on this branch is constructed with no
  `currentUpdatedAt` argument (e.g. `throw new PreconditionFailedError("Record
  changed since you loaded it")` with one arg) — confirmed `toErrorResponse`
  (`errors.ts:71-79`) omits `current_updated_at` from the body when
  `error.currentUpdatedAt` is falsy. Matches the report's stated semantics.

## Claim 4 — `expected_updated_at` stripped before DB write in all 5 routes

**CONFIRMED**, all 5:
- `projects/[id]/route.ts:63` — `const { expected_updated_at, ...fields } =
  parsed.data;` then `.update({ ...fields, ... })`.
- `tasks/[id]/route.ts:69` — same pattern with `input`/`fields`.
- `milestones/[id]/route.ts`, `risks/[id]/route.ts`, `issues/[id]/route.ts`
  — all build `updates: Record<string, unknown> = {}` field-by-field and
  never assign `updates.expected_updated_at = ...`, so it structurally
  cannot reach the DB write.

No "column does not exist" 500 is possible in any of the 5 — verified by
reading every update-payload construction site, not just the diff hunks.

## Claim 5 — lock/period-close guards vs. OCC check ordering

**CONFIRMED, no regression, with one design nuance worth flagging.**
`tasks/[id]/route.ts` and `milestones/[id]/route.ts` both run
`checkOptimisticConcurrency(...)` **before** the `touchesScheduleShape(...)`
→ `assertProjectUnlocked(...)` lock check (confirmed by line order in both
files). Projects/risks/issues have no lock guard on PATCH at all, so
ordering is moot there.

Practical effect: when `expected_updated_at` matches (or is omitted), OCC is
a no-op and the lock check runs and behaves exactly as before — verified by
the full suite staying green, including `governance/lock.test.ts` (15/15) and
`governance/lock-db-backstop.test.ts` (11/11), neither of which sends
`expected_updated_at`. The only behavior change is: a caller who sends a
**stale** `expected_updated_at` on a schedule-shape edit to a **locked**
project now gets 412 instead of 422. That's a defensible ordering (a stale
read should be surfaced before a business-rule rejection), but it is a
choice, not a forced consequence of "sensible order" — the report's phrasing
implies this was checked; I'd call it fine but worth the lead's eyes since it
wasn't explicitly called out in the report.

## Claim 6 — OpenAPI/llms/MCP drift tests genuinely green + 412 documented + MCP field types correct

**CONFIRMED**, with one caveat. Ran the full suite myself (not trusting the
report's numbers): `tools-zod.test.ts` 40/40, `openapi-coverage.test.ts`
144/144, `llms-coverage.test.ts` 143/143 (both now fully green — see note
above about the mfa/challenge fix landing since the report was written).
412 responses are present on all five PATCH ops in `openapi.json/route.ts`
(lines 311, 751, 845, 914, 981 — projects/milestones/tasks/risks/issues
respectively), all pointing at the shared `components.responses.
PreconditionFailed`. `llms.txt` carries the R-90 section
(`llms.txt/route.ts:82-93`). `mcp/tools.mjs` adds the shared
`expectedUpdatedAt` fragment (`type: "string", format: "date-time"`) to all
five `update_*` tools' `properties`, matching `z.string().datetime({offset:
true})` in intent.

**Caveat:** `tools-zod.test.ts` only checks (a) property-name existence,
(b) required-field parity, and (c) enum equality — it does **not** check
JSON-Schema `type`/`format` against the Zod type. So "the MCP tool schemas
carry the field with the correct type" is true by my manual read, but it is
**not machine-enforced** by any drift test — a future edit that typo'd
`format: "date"` instead of `"date-time"`, or dropped the type entirely,
would not fail CI. Not this worker's bug to fix, but worth flagging as a gap
in the drift-test's own coverage.

## Claim 7 — forms send the API's own value; 412 doesn't strand the form

**CONFIRMED**, all 5 forms (`project-form.tsx`, `task-form.tsx`,
`milestone-form.tsx`, `risk-form.tsx`, `issue-form.tsx`):
- Each interface gained `updated_at?: string | null`; each edit-mode payload
  conditionally spreads `{ expected_updated_at: X.updated_at }` only when
  `X?.updated_at` is truthy (or `mode === "edit" && project?.updated_at` for
  projects, which is stricter/equally correct). Since the `task`/`project`/
  etc. prop is `undefined` on create (confirmed via `task?: Task` optional
  prop signature), this is never sent on create — matches the report's claim
  exactly.
- The value is whatever the loading code put on the object — these routes'
  GET handlers all `.select("*")`, so `updated_at` is a real DB column
  present verbatim (not a client-reconstructed `Date`), avoiding the
  precision-loss failure mode the task asked me to check for.
- 412 handling: `catch (err) { const apiErr = err as ApiError; if
  (apiErr.status === 412) { setTopError(...); toast.error(...) } else {
  applyApiError(...) } setSaving(false); }` — `setSaving(false)` sits
  **outside** the if/else in all 5 forms, so the form is never left in a
  stuck "saving" state on a 412, confirmed by reading the full catch block
  in each file, not just the diff hunk. `topError` is an existing, already-
  rendered piece of UI state (`task-form.tsx:254-256`), not a new dead
  variable.

## Overall verdict

**Solid implementation — 5 of 7 claims fully confirmed, 2 confirmed with
minor caveats worth the lead's attention, 0 claims that hide a real bug.**
Nothing here blocks landing.

## Exact fixes (optional, none blocking)

1. **Cosmetic parity gap (Claim 1).** In all five `[id]/route.ts`, the
   `.select().single()` → `.select().maybeSingle()` swap applies even when
   `expected_updated_at` is not sent, changing the error text (not the
   status code or audit behavior) on an already-unreachable-in-practice
   zero-row race. If literal byte-identical omitted-field behavior matters,
   gate the `.single()`/`.maybeSingle()` choice on
   `expected_updated_at !== undefined` the same way the `.eq("updated_at",
   …)` clause is gated. Otherwise, no action needed — just don't describe it
   as byte-identical in the RTM/ADR text.
2. **Drift-test gap (Claim 6), not this worker's scope to fix now.**
   `web/src/lib/assistant/tools-zod.test.ts` doesn't check JSON-Schema
   `type`/`format` against the Zod type for any tool field, not just this
   one — a follow-up ticket, not a Sprint-blocking gap in this change.
3. **No route-level integration test exists for any of the five PATCH
   handlers** (pre-existing codebase pattern, not introduced by this
   change) — the lost-race → 412-no-audit path (Claim 3) is verified here
   by static reading only. If the lead wants that path machine-verified
   before it's trusted in production, it needs a mocked-Supabase route test
   that simulates a zero-row conditional update; not currently present for
   any of these five routes, OCC or not.

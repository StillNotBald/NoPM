# CLI — R-90 optimistic concurrency support

## Summary

Wired the API's opt-in optimistic-concurrency contract (see `reports/occ.md`)
into the zero-dependency `cli/` tool: a `--expected-updated-at <iso>` flag on
the five entity `update` subcommands, plus friendly 412 rendering.

## Files changed

- `cli/lib/api.mjs` — `api()` now special-cases a `412` response: builds a
  CliError whose `.message` is the friendly sentence (`Precondition failed:
  the record changed since you loaded it (current updated_at: <value>).
  Re-run with --expected-updated-at <value> after reviewing.`), sets
  `.status = 412`, and keeps `.payload` as the raw JSON error body. Falls
  back to `"unknown"` in the message if `current_updated_at` is absent (the
  documented lost-race branch in `occ.md` that omits it). Non-412 errors are
  unchanged.
- `cli/nopm.mjs` — hoisted a module-level `currentFlags` set once per
  invocation (needed because the top-level `main().catch()` handler is
  outside `main()`'s scope and has no other way to see `--json`). The catch
  handler now special-cases `e.status === 412 && currentFlags.json`: prints
  the raw `e.payload` as JSON instead of the friendly text. All other error
  rendering (the `✗ ` prefix, `fields` bullet list, dry-run short-circuit) is
  untouched.
- `cli/commands/{projects,tasks,milestones,risks,issues}.mjs` — each
  `update` case now does
  `if (f["expected-updated-at"]) body.expected_updated_at = f["expected-updated-at"];`
  immediately before the "no fields supplied" guard, and each module's
  `usage` array documents the flag on the `update` line plus a one-line
  explainer. `--flag=value` already worked for this flag with no code
  changes (generic `parseFlags` handling).
- `cli/test/cli.test.mjs` — 10 new tests (see below).
- `cli/README.md` — new "Optimistic concurrency" section (get → copy
  `updated_at` → update with `--expected-updated-at`, the 412 message, and
  the `--json` raw-body note) placed above "Four-eyes deletion governance";
  added the flag to the global-flags reference table.

## Design notes

- **Where the 412 logic lives.** The command modules never see HTTP status
  codes directly — they call `ctx.api(...)` and let errors propagate. The
  message-building and payload-preservation logic therefore lives in
  `lib/api.mjs`'s `api()`, the one place that talks to `fetch` and inspects
  `res.status`. This is also why the "412 message rendering" tests exercise
  `api()` directly against a stubbed `global.fetch`, not the command modules'
  stubbed `ctx.api` (which bypasses `lib/api.mjs` entirely by design, per the
  existing test architecture).
- **`--json` awareness.** The friendly-vs-raw branch had to live in
  `nopm.mjs`'s top-level `.catch()`, the only place both the parsed
  `--json` flag and the thrown error are simultaneously in scope for a real
  CLI invocation. Scoped narrowly to `status === 412` so no other error
  path's behavior changed.
- **No `--force` flag.** The teammate note in `occ.md` suggested pairing
  `--if-match`/`--force`; per this task's brief the flag name is
  `--expected-updated-at` (matching the API field name 1:1) and no bypass
  flag was requested, so none was added — omitting the flag already means
  "don't check," which is the bypass.

## Verify

- `cd cli && npm test` — **33/33 passing** (was 23/23 before this work; +10 new tests, 0 regressions).
- `node nopm.mjs tasks update --help` — prints the `update` usage line with
  `[--expected-updated-at <iso>]` and the explainer bullet. Confirmed.
- `node nopm.mjs tasks update fake-id --status-type done --expected-updated-at 2026-01-01T00:00:00Z --curl` —
  prints
  `curl -X PATCH '<url>/api/tasks/fake-id' ... -d '{"status_type":"done","expected_updated_at":"2026-01-01T00:00:00Z"}'`
  and makes no network call (dry-run path, confirmed by the `--curl` output
  containing the field and the process exiting 0 with no request sent).

## Unverified / left as-is

- Did not call the live API end-to-end (out of scope per instructions —
  tests use the stubbed-fetch / stubbed-ctx patterns only). The 412 body
  shape asserted in tests mirrors the example in `occ.md` exactly
  (`{ error, code, current_updated_at }`); if the live shape ever drifts
  from that, only the `lib/api.mjs` tests would need updating.
- Did not touch `cli/commands/{allocations,approvals,approve,audit,auth,
  budget,changes,clashes,decisions,documents,expenses,notifications,
  openapi,rebaselines,reports,resources,search,time,timeline,tokens,
  whoami}.mjs` — none of these have an `update`-style PATCH matching the
  five R-90 entities, per the file-scope boundary in the brief.

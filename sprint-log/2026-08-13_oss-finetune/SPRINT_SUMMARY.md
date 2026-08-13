# Sprint Summary — 2026-08-13_oss-finetune

**TL;DR:** Open-source readiness initiative — Wave 1 killed the agent tool-schema drift (5 write tools were 422-guaranteed) and made it structurally unrepeatable: one shared registry, Zod-lock tests, Zod-generated OpenAPI bodies, full llms.txt coverage.

## Declared goals
- Wave 1 (P0): fix agent tool-schema drift + expand MCP + drift locks (R-IDs: R-64, R-25, R-24)
- Wave 2 (P1): CLI hardening + installability (R-23)
- Wave 3 (P3): impeccable slop pass on web/src (R-50, R-51)
- Wave 4 (P4): checked-in gates, RTM tests column, E2E smoke, health script (R-60)
- Wave 5 (P2): OSS scrub, MIT license, history purge, publish pack

## Actual outcomes

### Wave 1 — agent tool-registry integrity (R-64)
Pre-wave audit finding: the assistant (`tools.ts`) and MCP server (`server.mjs`) carried two hand-maintained copies of the tool registry whose request schemas contradicted the API's Zod validators — `create_project` couldn't supply the required `code`, `create_risk` advertised `probability/impact` instead of `severity/likelihood`, `create_issue` advertised `severity` instead of the required `priority`, `create_task` and `create_milestone` advertised wrong enums, and `request_task_deletion` omitted the required `reason`. Five of six write tools returned 422 on every call. The existing drift test only checked path+method, so CI stayed green.

Shipped:
- `web/mcp/tools.mjs` — single shared registry (plain ESM), imported by BOTH the MCP server and `tools.ts`; copy-drift now structurally impossible. All schemas rewritten against the real validators, with real JSON-Schema `enum` arrays.
- Registry expanded 15 → 23 tools: `get_project`, `update_project`, `update_milestone`, `get_task`, `update_task`, `update_risk`, `update_issue`, `search_workspace` — the governed Kanban move (update_task status_type) is now agent-reachable. Scope ceiling unchanged (least-privilege preserved; verified by existing scope tests).
- `tools-zod.test.ts` — body-level drift lock: every write tool's properties/required/enums validated against the Zod schemas via `z.toJSONSchema` introspection; registry-identity + write-tool coverage assertions. Negative-tested (injected enum drift → red).
- OpenAPI request bodies for projects/milestones/tasks/risks/issues + task-deletion now **generated from the Zod validators** (`zodBody()` helper) — three-way drift (spec ↔ tools ↔ validators) eliminated at the root.
- `llms.txt` rewritten: all 109 documented operations indexed (was ~60), new "Field enums & formats" section, corrected maker-checker `reason` (REQUIRED, not optional); locked by new `llms-coverage.test.ts`.
- Root `.mcp.json` — zero-config MCP pickup in Claude Code for a cloned repo.
- `web/mcp/README.md` — 23-tool catalogue, Claude Code zero-config section.

### Wave 2 — CLI hardening + installability (R-23)
Pre-wave audit findings: `nopm <group> --help` silently executed the group's default live API call (verified: `projects --help` fired GET /api/projects); missing-id guards were defeated by their own `arg || f._[0]` fallback (`nopm tasks rm --reason x` sent `DELETE /api/tasks/rm`); `die()` called `process.exit(1)` mid-request, tripping a libuv assertion on Windows on every error; `private: true` with no license/engines; zero tests; PAT config written with default permissions.

Shipped:
- Errors-as-exceptions: `die()` now throws `CliError`; the dispatcher prints + sets `process.exitCode` — no more mid-request exits, no more libuv assertion.
- Central `--help`/`-h` interception in the dispatcher — prints the group's usage, structurally cannot fall through to a live call (all 26 groups at once).
- Missing-id guards fixed at all 3 `|| f._[0]` sites (tasks rm, approve, approve reject).
- `parseFlags`: `--flag=value` syntax (expresses values starting with `--`), `-h` → help.
- `--curl` global dry-run flag — prints the exact request with the token masked as `$NOPM_TOKEN`.
- `saveConfig`: 0700 dir / 0600 file (PAT at rest).
- New commands: `nopm timeline` (Mainline graph), `nopm openapi` (live spec index, no auth).
- `projects create` now requires `--code` (matches the validator — was a guaranteed 422 without it).
- Installable: `private` removed, MIT, `bin`, `files`, `engines >=20`, v1.0.0.
- `cli/test/cli.test.mjs` — 15 node:test contract tests (parseFlags/die/out units + stubbed-ctx URL/body assertions + "dies BEFORE any API call" guards + all-modules help contract). `npm test` wired.
- README rewritten (install, --curl, tests, full catalogue pointer).

### Wave 3 — impeccable slop pass (R-50/R-51 + console tokens)
Pre-wave audit verdict: the frontend was nearly slop-free (zero console.logs/TODOs/gradients/marketing filler); the real defect was **stale hand-typed proof metrics** on the page whose thesis is traceability, plus a handful of off-token colors.

Shipped (impeccable `polish` — refinement, incumbent world preserved; detector: 0 findings):
- `scripts/gen-metrics.mjs` + `src/lib/metrics.gen.json` — proof metrics GENERATED from the repo (R-IDs from REQUIREMENTS.md, endpoints from the route tree, tests from a vitest JSON run). Landing, case study (incl. meta description), and the PDF one-pager all import the JSON; `--check` mode for CI (wired in Wave 4). Stale 52/268/61 → live 54/533/61, and the case-study copy now states the numbers are generated, not typed.
- Killed `accent-[#D97757]` (Anthropic brand clay) on the PAT scope checkboxes → `accent-accent`.
- New status tokens `--sev-high` (#ea580c / #db6d28 dark) and `--change` (#7c3aed / #a371f7 dark) replacing raw hexes in severity.tsx, queue-list.tsx, inline-action.tsx, project-tabs.tsx — dark theme now correct for both.
- Clashes over-allocation pill: raw amber Tailwind palette (light-only, broken on dark) → warning tokens.
- Shared `<TerminalCard>`/`<TrafficLights>` — the 4 hand-inlined terminal chromes unified (one surface #0e0e0f, consistent sizing, consistent aria-hidden).
- Shared `<WedgeGrid>` — the three-wedge argument now has one source; landing and case study can no longer fork.
- globals.css: stale double header ("Apple/iOS…", "Linear acid-lime…") rewritten to describe the actual macOS-terminal-light theme; `--font-serif` renamed `--font-display` (it is SF Pro Display, a sans — the old name lied).
- Deleted dead 262-line `components/forms/budget-form.tsx` (zero importers, verified).
- `lib/review/gather.ts`: last `any` in the codebase removed (bare `SupabaseClient`, house style).

Verified: tsc clean, 533/533 tests, eslint 1 pre-existing warning only, production build green, impeccable detector 0 findings.

## R-IDs touched
- R-64 → DONE (new)
- R-25 → code column updated (tools.mjs)
- R-23 → hardened; tests column filled

## Files
- `web/mcp/tools.mjs` (new), `web/mcp/server.mjs`, `web/src/lib/assistant/tools.ts`
- `web/src/lib/assistant/tools-zod.test.ts` (new), `web/src/lib/api/llms-coverage.test.ts` (new)
- `web/src/lib/assistant/tools-openapi.test.ts`, `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts`
- `.mcp.json` (new), `web/mcp/README.md`

## Tests / verification
- 533/533 vitest green (was 371; +37 zod-lock, +109 llms-coverage, +expanded openapi-lock)
- `npx tsc --noEmit` clean; `npm run rtm:verify` OK
- Drift guard negative-tested: injected `mitigated`→enum drift produced 2 failures, revert → green
- Registry smoke: 23 tools load in plain Node; `toRequest({})` safe on all (fallback.ts contract)

## Follow-ups
- Waves 2-5 (this initiative, in flight)
- Remaining hand-written OpenAPI request bodies (documents/decisions/change-requests/resources/allocations) could adopt `zodBody()` too

# ADR 0019 — Module registry (Level 1): turn modules off per deployment

- **Status:** Accepted (Level 1). Built on `feat/module-registry-level-1`; steps 1 (registry) and 2 (edges) shipped, step 3 and the layering moves are follow-ups (see "What shipped").
- **Date:** 2026-10-18
- **Source:** the 2026-10-17 night review, question 2 ("Can NoPM be modular?"), `_docs/review-2026-10-17-night/nopm-integration-and-modularity.md`
- **Builds on:** ADR 0006 (flat scope list), ADR 0007 (MCP surface), ADR 0012 (integration hub), ADR 0014 (approver roles)

## Context

The owner's stated goal is "only use what we need". Today NoPM has Level 0 only: `ESSENTIAL_HREFS` in `web/src/lib/nav/nav-config.ts` hides 16 of the 23 sidebar items for new users. That is presentation. Every route, API endpoint, MCP tool, OpenAPI entry, scope and table is still there.

There is no module switch. The environment scan finds no feature flag; every variable is infrastructure, a rate limit, demo mode or a secret. One module already behaves like a switch by data: with no active Lark connector, `runApprovalRequested` returns at once, so the hub is inert. The code is still shipped, imported and tested.

Deleting a folder does not work, because about eight hand-kept lists and couplings name every feature (see "The registries" below). The 75 migrations are one linear history with functions that name tables of several modules, so "skip these migrations" is not an option either.

### The levels

| Level | Exists | What it gives | Rough cost (reviewer's estimate) |
|---|---|---|---|
| 0: hide in nav | Yes | Cleaner UI | done |
| 1: per-module switch | No | A deployment turns modules off. Disabled routes return 404. Nav, palette, MCP tools, `llms.txt`, OpenAPI and scope minting hide them. The database stays complete. | 1 to 2 weeks. No schema change. |
| 2: delete-a-folder | No | A derived product omits a module's code | 4 to 8 weeks on top of Level 1, module by module. Migration history is the hardest part. |
| 3: packages in a workspace | No | Reuse across other apps | Months for the kernel alone. Worth it only with a second consumer. |

## Decision

Build **Level 1** first. Add a module registry and enforce it at the edges. Decide Level 2 per module afterwards, by value. Do not start Level 3 until a second product needs the kernel.

Level 1 delivers "only use what we need" for a deployment, because an unused module becomes invisible and unreachable. It does **not** shrink the code or the schema, and this should be said plainly to anyone who asks for a smaller footprint.

### Final module table (as built)

The registry is `web/src/lib/modules.ts`. The table below is generated from it. The kernel is never switchable: naming it in `NOPM_MODULES` is harmless and omitting it cannot turn it off.

| Id | Module | Kind | Depends on | Nav | API prefixes | MCP tools | Scope resources |
|---|---|---|---|---|---|---|---|
| `tenancy_auth` | Tenancy, auth and tokens | kernel | - | `/tokens` | `/health`, `/auth`, `/tokens`, `/me`, `/invites`, `/openapi.json`, `/mcp` | 0 | - |
| `audit` | Audit | kernel | - | - | `/audit` | 1 | `audit` |
| `governance` | Four-eyes, governed deletion and locks | kernel | - | `/approvals` | `/deletion-requests`, `/projects/*/lock`, `/projects/*/unlock` | 0 | - |
| `notifications` | Notifications | kernel | - | - | `/notifications` | 0 | `notification` |
| `work` | Projects, tasks, milestones and members | kernel | - | `/my-work`, `/my-tasks`, `/projects`, `/tasks` | `/projects`, `/programs`, `/tasks`, `/milestones`, `/search` | 14 | `project`, `program`, `milestone`, `task` |
| `portfolio` | Dashboard and portfolio | optional | - | `/dashboard`, `/portfolio` | `/metrics` | 0 | - |
| `mainline` | Mainline timeline | optional | - | `/mainline` | `/timeline` | 0 | - |
| `sprints` | Sprints | optional | - | `/sprints` | `/sprints` | 0 | `sprint` |
| `risks_issues` | Risks and issues | optional | - | `/risks`, `/issues` | `/risks`, `/issues`, `/projects/*/risks`, `/projects/*/issues` | 6 | `risk`, `issue` |
| `resources` | Resources and capacity | optional | - | `/resources` | `/resources` | 1 | `resource` |
| `clashes` | Clashes and allocations | optional | `resources` | `/clashes` | `/clashes`, `/allocations` | 1 | `clash` |
| `budget` | Budget and expenses | optional | - | `/budget` | `/projects/*/budget`, `/projects/*/expenses`, `/expenses` | 1 | `budget` |
| `reports` | Reports, decks and CSV export | optional | - | - | `/reports`, `/export` | 0 | - |
| `documents` | Documents | optional | - | `/documents` | `/documents` | 1 | `document` |
| `decisions` | Decisions | optional | - | `/decisions` | `/decisions`, `/projects/*/decisions` | 1 | `decision` |
| `change_control` | Change control | optional | - | `/change-control` | `/change-requests`, `/projects/*/change-requests` | 1 | `change` |
| `baselines` | Baselines and rebaselines | optional | - | `/baselines` | `/rebaselines`, `/projects/*/rebaselines` | 3 | `rebaseline` |
| `review` | Review inbox | optional | - | `/review` | `/review` | 1 | - |
| `trust` | Trust centre | optional | - | `/trust` | - | 0 | - |
| `assistant` | Assistant (bring your own key) | optional | - | - | `/assistant` | 0 | `assistant` |
| `integrations` | Integration hub and Lark | optional | `notifications` | `/integrations` | `/integrations` | 0 | - |
| `calendar` | Calendar feeds | optional | - | - | `/calendar-feeds`, `/calendar` | 0 | - |
| `saved_views` | Saved views | optional | - | - | `/saved-views` | 0 | `saved_view` |

Choices that differ from the first draft of this ADR:

- **`approvals` (the governed-deletion queue) is kernel**, not part of the review inbox. It is where the second person decides a task or project deletion, so a deployment without it could not complete the four-eyes flow.
- **CSV export lives in `reports`**, with decks, as the task brief asked. Switching `reports` off also removes `GET /export` for every entity.
- **`notifications` is its own kernel module** so that `integrations` can declare the real dependency it has (the hub delivers through notifications).
- **`clashes` depends on `resources`** because allocations are checked against member capacity.
- **`search` stays in the kernel** (`work`), because the `search_workspace` tool and the command palette use it.
- Hour logging and timesheets no longer exist (owner decision 18), so there is no timesheet module.

### What shipped

`NOPM_MODULES` is one comma list of optional module ids. Unset or blank means everything on, which is byte-identical to the product before this change (locked by snapshot tests of `openapi.json`, `llms.txt`, the MCP tool list and the scope list). An unknown id, or an enabled module whose `dependsOn` is off, throws `Invalid NOPM_MODULES` on first use.

| Registry | How it is gated |
|---|---|
| Edge gate | `proxy.ts` calls `isPathDisabled`: `/api/*` of a disabled module answers 404 `not_found` in the standard envelope; a console page is rewritten to `/module-disabled`, which renders the console 404 |
| Navigation | The console layout passes the disabled ids to the shell; the sidebar, bottom nav and command palette read them through `modules-context`. The assistant button and panel are not rendered when `assistant` is off |
| Scopes | `isValidScope` and `scopeChoices` refuse a disabled module's scopes, so a token cannot be minted with them. The token page's checkboxes and the agent preset follow |
| MCP tools | `/api/mcp` and the in-app assistant list and call only enabled tools |
| OpenAPI | `openapi.json` serves the spec without the paths of disabled modules (schemas stay; the full spec is still what the coverage tests check) |
| `llms.txt` | Endpoint lines and the sections of disabled modules are removed, and the tool count follows |
| Coverage tests | Unchanged and green: they check the full, all-on spec. A new `modules.test.ts` asserts that every API route folder, OpenAPI path, `llms.txt` endpoint line, console page, nav item, scope and MCP tool belongs to exactly one module, so the registry cannot drift |

Not done, and listed as follow-ups:

1. **Stdio MCP server** (`web/mcp/server.mjs`) still lists every tool. It runs in plain Node and cannot import the TypeScript registry. Its calls to a disabled module return the API's 404, so nothing becomes reachable.
2. **CLI commands** are not filtered (the dispatcher loads `cli/commands/*.mjs`); a disabled module's command gets the 404.
3. **Layering moves** from step 1 (generic `Field` and `InlineAlert` out of `comp/integrations/shared`, nav counts passed in instead of imported, the `lib/review` import of `comp/governance`) are not done. They do not affect Level 1 behaviour.
4. **Step 3**: the event port that replaces the three `emit*` calls in `governance/decide.ts`, the idempotent migration so `nopm_project_child_counts` and the lifecycle guards tolerate unused tables, and a full smoke run against a minimal profile.
5. **Dashboard, portfolio and reports guards.** These pages read other modules' tables directly. A disabled module's tables stay and are empty, so they render, but they show zeros for it. Guards that hide those cards are not added.
6. **Project detail** (`api/projects`) still imports the child route modules. The child routes are 404 at the edge when their module is off, but the project page's tabs for them are not hidden.
7. **The integrations page** also holds the calendar-feed settings. With `calendar` off and `integrations` on, that card calls a 404 API.
8. **Client bundle**: nav filtering is passed from the server at request time, so `NOPM_MODULES` needs no build-time baking. `openapi.json` and `llms.txt` read it at server start (the tool count in `llms.txt` is fixed at import).

## Consequences

- **Good:** an admin or a derived deployment gets a smaller product without a fork. A disabled module is invisible to people, agents and the spec, so the OpenAPI document, `llms.txt` and the MCP tool list stay honest about what the deployment can do.
- **Cost:** about one to two weeks, and the registry becomes a place that must be edited whenever a feature is added. The "every folder belongs to one module" test is what keeps it from drifting.
- **Limits, stated plainly:** the code and the full schema still ship. A disabled module's tables stay and are simply empty. Any join across modules needs a guard. This is a runtime switch, not a smaller product.
- **Risk:** the project API (`api/projects`) imports eight child route modules, so the project detail page cannot omit a child module's tab without edits (follow-up 6 above). The child routes themselves are 404 at the edge.
- **Environment variable first.** The switch is per deployment (`NOPM_MODULES`) because that needs no schema. A per-workspace setting is still open.

## Open questions for the owner (carried over, not decided here)

1. Is "a deployment turns modules off" enough, or is a smaller code footprint (Level 2) the real goal?
2. Environment variable first, or a workspace setting from the start?
3. Which profile should be the first proven one: the "minimal" profile above, or a profile that mirrors a specific client?

## Alternatives considered

- **Do nothing beyond Level 0.** Cheap, but nothing stops a user or an agent from reaching an unused module, and the spec keeps advertising it.
- **Go straight to Level 2.** Rejected for now. It needs the Level 1 registry anyway, plus per-module migration sets, and migration history is the hardest part.
- **Level 3, packages in a workspace.** Rejected until a second product needs the kernel. NoPM's governance code is Next routes and service-role calls mixed with business rules, so this would be a rewrite behind ports, not a move.

## Related

- ADR 0006 (flat scope list), ADR 0007 (MCP surface), ADR 0012 (integration hub; its three `emit*` calls are the seam in step 3), ADR 0014 (approver roles).

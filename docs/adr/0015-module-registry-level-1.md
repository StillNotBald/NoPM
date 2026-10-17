# ADR 0015 — Module registry (Level 1): turn modules off per deployment

- **Status:** Proposed (not accepted; needs the owner's decision before any code)
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

## Decision (proposed)

Build **Level 1** first. Add a module registry and enforce it at the edges. Decide Level 2 per module afterwards, by value. Do not start Level 3 until a second product needs the kernel.

Level 1 delivers "only use what we need" for a deployment, because an unused module becomes invisible and unreachable. It does **not** shrink the code or the schema, and this should be said plainly to anyone who asks for a smaller footprint.

### Kernel versus optional modules

The kernel is what every module needs. It is never switchable.

**Kernel (always on)**

| Part | Why it stays |
|---|---|
| Workspace tenancy | Every query filters `workspace_id`; guarded by `workspace-isolation.test.ts` |
| Auth and scopes | `lib/auth` and the flat `SCOPES` list (ADR 0006) |
| Audit | `writeAudit`, `audit_log`, channel and principal columns |
| Four-eyes and approver role | `principalOf`, `requireApprover`, the database triggers |
| Governed deletion and locks | `deletion_requests`, project lock, child-count fingerprint |
| Projects, milestones, tasks, `resource_members` | `tasks.assignee_id` points at `resource_members` |
| Notifications and the rate limiter | Used by governance and the public routes |

**Optional modules (switchable)**

| Module | Folders and surfaces | Tables it owns | Leaks to note |
|---|---|---|---|
| Portfolio and dashboard | `comp/dashboard`, `portfolio`, `lib/insight` | none | Reads six other modules' tables |
| Mainline | `lib/mainline`, `timeline`, `schedule` | none | `lib/timeline` imports `lib/nav` |
| Sprints | `lib/sprints`, page `sprints` | `sprints` | `tasks.sprint_id` FK; `lib/insight` imports it |
| Risks and issues | `comp/registers`, pages `risks`, `issues` | `risks`, `issues` | Register UI kit is shared |
| Clashes and allocations | `lib/clash` | `clashes`, `allocations` | Read by portfolio and reports |
| Resources and capacity | `lib/resource` | `allocations`; member table stays | Assignee FK keeps the member table |
| Budget and EVM | `lib/evm`, `lib/export` | `project_budget`, `expenses` | Project-deletion child counts name them |
| Reports and case study | `lib/reports` | none | Reads six tables |
| Documents | `lib/documents` | `documents` + storage bucket | Project tabs |
| Decisions | page `decisions` | `decisions` | Review queue |
| Change control | page `change-control` | `change_requests` | Review queue, Lark cards, catch-up |
| Baselines and rebaselines | page `baselines` | `rebaselines`, `rebaseline_signoffs` | MCP tools |
| Review inbox | `lib/review`, pages `review`, `approvals` | none | Composes the other approval kinds |
| Trust centre | page `trust` | reads `audit_log` | UI only |
| Assistant (BYOK) | `lib/assistant`, `comp/assistant` | four `assistant_*` tables | App shell mounts the panel |
| Integration hub and Lark | `lib/integrations`, `comp/integrations` | eight hub tables | Governance calls three `emit*` functions |
| Calendar feeds | `lib/calendar` | `calendar_feeds` | OpenAPI |
| Onboarding, prefs, theme, views | `lib/onboarding`, `prefs`, `theme`, `views` | `user_preferences` | Import `app/api/me` |

The module map is the reviewer's measurement and must be re-checked when the registry is written; it is the input to the registry, not a promise.

### The registries to gate

These are the hand-kept lists that today decide what exists. Level 1 makes each read the registry instead of keeping its own copy.

1. **Navigation:** `NAV_SECTIONS`, `ESSENTIAL_HREFS` and labels in `lib/nav/nav-config.ts`, plus the command palette and the bottom nav.
2. **Scopes:** the flat `SCOPES` list and `isValidScope` in `lib/auth/scopes.ts` (token minting must not offer a scope of a disabled module).
3. **MCP tools:** `MCP_TOOLS` in `web/mcp/tools.mjs` (about 38 tools).
4. **OpenAPI:** `app/api/openapi.json/route.ts` (16 route-group imports).
5. **`llms.txt`:** `app/llms.txt/route.ts`.
6. **CLI:** `cli/commands/*.mjs`. The dispatcher already loads the folder dynamically, so this one needs only the filter.
7. **Edge gate:** `proxy.ts`, the single choke point where page and `/api/*` prefixes of an off module can return 404.
8. **Coverage tests:** `openapi-coverage`, `llms-coverage`, `tools-openapi`, `tools-zod` and `schemas` assert the whole surface and fail when a module is removed. They must read the registry.

### First three steps

1. **Write the registry and fix the cheap layering leaks.** Add `web/src/lib/modules.ts`: one typed list with module id, label, nav hrefs, page prefix, API prefix, scope prefix, MCP tool names, CLI group, OpenAPI tag, `llms.txt` section and `depends_on`. Read `NOPM_MODULES` (default all on). Add a test that every page folder, API folder, scope and MCP tool belongs to exactly one module or the kernel. In the same change do the pure moves: move the generic `Field` and `InlineAlert` primitives out of `comp/integrations/shared` (three governance screens import them), pass counts into nav instead of importing governance, and remove the `lib/review` import of `comp/governance`.
2. **Enforce it at the edges.** In `proxy.ts`, return 404 for pages and `/api/*` whose module is off. Filter `NAV_SECTIONS`, the command palette and the bottom nav. Filter `MCP_TOOLS`, `openapi.json`, `llms.txt` and `isValidScope` by the registry. Make the coverage tests registry-driven so a disabled module no longer fails them. Add guards in dashboard, portfolio and reports. Make the assistant panel in the app shell conditional.
3. **Make the two circular seams explicit and prove a minimal profile.** Replace the three `emit*` calls in `governance/decide.ts` with an event port the hub subscribes to when its module is on. Add an idempotent migration so `nopm_project_child_counts` and the lifecycle guards tolerate unused tables. Then define a "minimal" profile (kernel, core work, governance, change control) and run the full suite and the smoke script against it, so "governance and tasks without budget, resources, Lark, assistant, mainline" is tested rather than asserted.

After step 3, choose Level 2 per module by value: the Lark hub first (inert when unused, 21 files, 8 tables, one inbound seam), then the assistant, then budget and EVM.

## Consequences

- **Good:** an admin or a derived deployment gets a smaller product without a fork. A disabled module is invisible to people, agents and the spec, so the OpenAPI document, `llms.txt` and the MCP tool list stay honest about what the deployment can do.
- **Cost:** about one to two weeks, and the registry becomes a place that must be edited whenever a feature is added. The "every folder belongs to one module" test is what keeps it from drifting.
- **Limits, stated plainly:** the code and the full schema still ship. A disabled module's tables stay and are simply empty. Any join across modules needs a guard. This is a runtime switch, not a smaller product.
- **Risk:** the project API (`api/projects`) imports eight child route modules, so project detail cannot omit a child module without edits. Step 2 must include it.
- **Not decided here:** whether the switch is an environment variable (per deployment) or a workspace setting (per tenant). The review recommends the environment variable first because it needs no schema.

## Open questions for the owner

1. Is "a deployment turns modules off" enough, or is a smaller code footprint (Level 2) the real goal?
2. Environment variable first, or a workspace setting from the start?
3. Which profile should be the first proven one: the "minimal" profile above, or a profile that mirrors a specific client?

## Alternatives considered

- **Do nothing beyond Level 0.** Cheap, but nothing stops a user or an agent from reaching an unused module, and the spec keeps advertising it.
- **Go straight to Level 2.** Rejected for now. It needs the Level 1 registry anyway, plus per-module migration sets, and migration history is the hardest part.
- **Level 3, packages in a workspace.** Rejected until a second product needs the kernel. NoPM's governance code is Next routes and service-role calls mixed with business rules, so this would be a rewrite behind ports, not a move.

## Related

- ADR 0006 (flat scope list), ADR 0007 (MCP surface), ADR 0012 (integration hub; its three `emit*` calls are the seam in step 3), ADR 0014 (approver roles).

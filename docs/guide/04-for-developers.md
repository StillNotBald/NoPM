# For developers

This chapter is for someone reading the code, not just using the product. It assumes you know TypeScript and REST APIs. It stays short on purpose. It links to the real files instead of restating them, so it can't drift out of sync with the code.

## Repo map

```
NoPM/
├─ web/                     Next.js app: API routes, console UI, MCP server, migrations
│  ├─ src/app/api/          every action is a documented route.ts, wrapped with route()
│  ├─ src/app/(console)/    the browser UI; it calls the same API everyone else calls
│  ├─ src/lib/              auth guards, the audit writer, scopes, governance rules
│  ├─ mcp/                  the MCP server + the shared agent tool registry (tools.mjs)
│  └─ supabase/migrations/  SQL files, applied in filename order by `npm run migrate`
├─ cli/                     the `nopm` CLI, zero dependencies, talks only to the public REST API
├─ requirements/            REQUIREMENTS.md (canonical requirement list) + TRACEABILITY.md (RTM)
├─ sprint-log/              dated build receipts, one folder per unit of work
├─ docs/adr/                architectural decision records
└─ scripts/                 governance gates: rtm-verify, commit-gate, health checks
```

## The one JSON contract

Every endpoint returns exactly one of two shapes:

- Success: `{ "data": ... }`. List endpoints add `total`, `page`, `limit` alongside `data`.
- Failure: `{ "error": "..." }`. Validation failures add a `fields` array naming which field was wrong.

Status codes are meaningful and consistent: `401` (not authenticated), `403` (authenticated but missing the required scope), `404` (not found), `422` (a business rule was violated, like trying to approve your own request), `429` (rate limited). See `web/src/lib/api/response.ts` for the response helpers (`ok`, `okList`, `created`, `fail`, `validationError`) and `web/src/lib/api/errors.ts` for the typed error classes (`AuthError`, `ScopeError`, `NotFoundError`, `RuleError`, `RateLimitError`) that get converted into that contract automatically.

## The `route()` wrapper

Every endpoint is wrapped in `route()` (`web/src/lib/api/handler.ts`), which:

1. Resolves the caller into an `Actor` (either a logged-in session or a Bearer PAT), unless the route explicitly opts out with `{ auth: false }` (used only by public/liveness routes like `/api/health` and `/api/openapi.json`).
2. Applies a workspace-and-actor-keyed rate limit.
3. Runs your handler.
4. Catches anything your handler throws and converts it into the `{ error }` contract with the right status code.
5. Stamps a request-id header on the response either way, so a failed call is just as traceable as a successful one.

You never write try/catch for the standard error cases yourself. You just `throw` the right typed error (`throw new ScopeError()`, `throw new NotFoundError("Project not found")`) and `route()` handles the rest.

## Adding an endpoint the governed way

A real, working example, `GET /api/projects/:id/risks` (`web/src/app/api/projects/[id]/risks/route.ts`), shows the shape every read endpoint follows:

```ts
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "risk:read");            // 1. check the scope first

  const db = createAdminClient();
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)      // 2. ALWAYS filter by the caller's workspace
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");
  // ... query, paginate, return okList(items, { total, page, limit })
});
```

The workspace filter in step 2 is not optional decoration. Token callers go through the admin database client, which bypasses the database's own row-level security, so if a query forgets `.eq("workspace_id", actor.workspaceId)`, that is a real cross-tenant data leak, not a cosmetic bug. Every write endpoint follows the same shape, plus one more required step: calling `writeAudit()` (`web/src/lib/audit/write.ts`) with the workspace id, the actor, an action string (like `"task.create"`), the target type and id, and optionally a before/after snapshot. `writeAudit` throws if the row can't be written, and that's deliberate. A handler that catches and swallows that error has just created a silent, ungoverned write, which is exactly what this whole codebase exists to prevent.

## Tests and gates

```bash
cd web
npm test                 # vitest: unit tests + governance-invariant tests
npx tsc --noEmit         # typecheck
npm run rtm:verify       # requirements ↔ RTM ↔ on-disk code paths, all in sync
```

A pre-push git hook runs the full test suite, the typecheck, `rtm:verify`, a check that generated proof-metrics haven't drifted, and the CLI's own contract tests, so these all run automatically before code leaves your machine, not just in CI.

## Adding an MCP tool

Agent tools live in exactly one place: `web/mcp/tools.mjs`. Both the MCP server and the in-app BYOK assistant import from this same file, so there is no second copy that can quietly drift out of sync. To add a tool:

1. Add an entry to the `TOOL_REGISTRY` array in `web/mcp/tools.mjs`: a `name`, a `description`, a JSON-Schema `parameters` object, and a `toRequest(args)` function that maps the tool call onto a real REST request (`{ path, method, body? }`).
2. Make sure the field names, required fields, and any enums match the corresponding endpoint's Zod validator exactly. `web/src/lib/assistant/tools-zod.test.ts` checks this automatically and fails the build if they drift apart.
3. If the tool is new enough to need an OpenAPI entry, `web/src/lib/assistant/tools-openapi.test.ts` checks tool coverage against the spec.
4. Never give a tool a scope higher than the least-privilege ceiling the assistant is allowed to hold. The test suite specifically asserts the assistant can never hold an approve, admin, or token-management scope.

## Where the RTM lives

`requirements/REQUIREMENTS.md` is the canonical list of requirements (each with an R-ID, like `R-24`). `requirements/TRACEABILITY.md` mirrors it one-to-one: for every R-ID, which files implement it and which tests prove it. The rule is that both files get updated in the same commit as any change that affects a requirement. `npm run rtm:verify` checks that the two files stay consistent and that the file paths they list actually exist on disk.

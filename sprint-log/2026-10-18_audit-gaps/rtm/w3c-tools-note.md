# W3-C note for `web/mcp/tools.mjs` (W3-A owns the file this wave; the lead applies this)

All changes are additive. `list_pending_approvals` gains a `mine` flag; `get_evm` and `get_budget` need only description text, because their responses already carry the new fields through the REST routes.

## 1. `list_pending_approvals` (around line 877)

Add one sentence to the end of `description`:

```js
"Pass mine=true to see only the requests assigned to the person behind this token " +
"(each item also carries assigned_to_me and assigned_approver_id). Assignment is routing only: " +
"it never changes can_decide.",
```

Add to `parameters.properties`:

```js
mine: { type: "boolean", description: "Only requests assigned to the person behind this token (default false: the whole queue)" },
```

Replace `toRequest` with:

```js
toRequest: (args) => {
  const params = new URLSearchParams();
  if (args.kind) params.set("kind", String(args.kind));
  if (args.mine === true) params.set("mine", "1");
  if (args.page) params.set("page", String(args.page));
  if (args.limit) params.set("limit", String(args.limit));
  const qs = params.toString();
  return { path: qs ? `/api/review?${qs}` : "/api/review", method: "GET" };
},
```

The guard (`guardTool`) compares only method and path shape, so the added query parameter is fine.

## 2. `get_evm` description (around line 666)

Replace "CPI, SPI, EAC, ETC, VAC plus committed." with:

```
"CPI, SPI, EAC, ETC, VAC plus committed. EAC follows the project's forecast_method: cpi (budget / CPI) or " +
"bottom_up (spent + committed + the manual estimate_to_complete). Both are returned as eac_cpi and eac_bottom_up; " +
"eac_bottom_up is null until someone has entered an estimate_to_complete, and eac is then null too when the " +
"method is bottom_up."
```

## 3. Optional: `update_budget` / budget tool

If a budget write tool exists, allow `estimate_to_complete` (number or null, zero or more) and `forecast_method` (`cpi` | `bottom_up`) in its parameters and body. Both are accepted by `PATCH /api/projects/:id/budget` and need no change request on a locked project. If no such tool exists, nothing to do.

## 4. Optional: a `get_project_trend` read tool

```js
{
  name: "get_project_trend",
  description:
    "Get the daily snapshot trend of a project and the RAG it SUGGESTS (green, amber or red) with the reason, " +
    "for example \"SPI 0.86 falling over 3 weeks\". The suggestion is advice shown beside the declared RAG; " +
    "it never changes it. Optional n = how many days of snapshots (default 28, max 120).",
  parameters: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "Project UUID" },
      n: { type: "number", description: "Snapshots to use (default 28, max 120)" },
    },
    required: ["project_id"],
    additionalProperties: false,
  },
  toRequest: (args) => ({
    path: `/api/projects/${idSeg("project_id", args.project_id)}/trend${args.n ? `?n=${encodeURIComponent(String(args.n))}` : ""}`,
    method: "GET",
  }),
},
```

If added, `assistant/tools.ts` and the OpenAPI drift guards need the matching entry (the OpenAPI entry is in `w3c-openapi-notes.md`).

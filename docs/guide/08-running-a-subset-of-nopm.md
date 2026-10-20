# Running a subset of NoPM

NoPM has a small always-on core and a set of optional modules. A deployment can switch the optional modules it does not need. A switched-off module disappears from the menu, the API, the agent tools and the API description, and its web addresses answer "not found". This guide is for whoever runs the deployment. It is a switch, not a smaller program: the code and the database still contain everything.

## Turn modules on or off

Set one environment variable on the server, then restart it.

```
NOPM_MODULES=risks_issues,documents,change_control
```

- **Unset or blank:** every module is on. This is the normal setup and behaves exactly like NoPM did before the switch existed.
- **A comma list:** only the optional modules you name are on, plus the core. You never have to name the core, and you cannot turn it off.
- **A typo or a missing partner:** every request fails with "Invalid NOPM_MODULES" and names the problem. For example `NOPM_MODULES=clashes` fails because clashes need `resources`. An unknown name fails too.

## The always-on core

You cannot switch these off, because everything else stands on them.

| Core part | Pages and API |
|---|---|
| Tenancy, sign-in, tokens | Tokens, settings, start, `/api/auth`, `/api/tokens`, `/api/me`, `/api/invites`, `/api/health`, `/api/openapi.json`, `/api/mcp` |
| Audit | `/api/audit` and the audit tool |
| Four-eyes, governed deletion, locks | Approvals page, `/api/deletion-requests`, project lock and unlock |
| Notifications | `/api/notifications` |
| Projects, tasks, milestones, members | My Work, My Tasks, Projects, Tasks, search |

## The optional modules

| Module id | What it is | Needs |
|---|---|---|
| `portfolio` | Dashboard and portfolio pages | |
| `mainline` | Mainline timeline | |
| `sprints` | Sprints | |
| `risks_issues` | Risk and issue registers | |
| `resources` | Resources and capacity | |
| `clashes` | Clashes and allocations | `resources` |
| `budget` | Budget and expenses | |
| `reports` | Reports, decks and CSV export | |
| `documents` | Documents | |
| `decisions` | Decisions | |
| `change_control` | Change requests | |
| `baselines` | Baselines and rebaselines | |
| `review` | Review inbox | |
| `trust` | Trust centre page | |
| `assistant` | The bring-your-own-key assistant | |
| `integrations` | Integration hub and Lark | `notifications` (core, always on) |
| `calendar` | Calendar feeds | |
| `saved_views` | Saved views | |

The full table, with the exact API paths, tools and scopes of each module, is in [ADR 0019](../adr/0019-module-registry-level-1.md) and in `web/src/lib/modules.ts`.

## What a switched-off module loses

- **Menu:** its sidebar, bottom-bar and command-palette entries are gone. If the assistant is off, its button and panel are gone too.
- **Pages:** opening its address shows the console "page not found".
- **API:** its `/api/...` addresses answer 404 in the normal error format.
- **Tokens:** its scopes cannot be minted, and the token page does not list them. Tokens minted earlier keep their scope names, but the routes they pointed at are gone.
- **Agents:** its tools are missing from the remote MCP server and from the in-app assistant. `/api/openapi.json` and `/llms.txt` no longer describe it, and the tool count in `/llms.txt` follows.

## What it does not do

- **The code and the database are unchanged.** A switched-off module's tables stay and are simply empty. No migration is skipped.
- **The stdio MCP server and the CLI** still list every tool and command. A call into a switched-off module gets the API's 404.
- **Dashboard, portfolio and reports** read other modules' tables directly, so a switched-off module can show as zeros there rather than vanish.
- **CSV export** is part of `reports`, for every kind of record.
- **The project page** still shows tabs for the modules it embeds, though their API is 404.

## A small example

A team that wants tasks, risks and four-eyes deletion, and nothing else:

```
NOPM_MODULES=risks_issues
```

They keep My Work, Projects, Tasks, Approvals and Tokens from the core, plus Risks and Issues. Budget, Sprints, Lark, the assistant and the rest are not in the menu, not in the API description, and not reachable.

## For developers

When you add a page, an API route, an agent tool or a scope, add it to the owning module in `web/src/lib/modules.ts`. `modules.test.ts` fails if any of them has no owner, so a new feature cannot slip past the switch.

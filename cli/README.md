# `nopm` CLI

Drive NoPM from your terminal — or hand it to your AI agent. Scoped Bearer token, documented endpoints, `--json` for machine output, `--curl` to see exactly what would be sent.

The CLI has **zero dependencies** and **no database access** — every command is a thin call to the public REST API, so it can't cheat the governance layer even if it wanted to.

## Install

```bash
# from a clone
node cli/nopm.mjs --version

# or link it globally
cd cli && npm link          # then just:  nopm projects ls
```

## Auth

```bash
nopm auth set-token npm_xxx --url https://stillnotbald.com   # save your scoped PAT (0600 perms)
nopm whoami                                                  # show actor + scopes
```

Environment variables `NOPM_TOKEN` / `NOPM_API_URL` override the saved config.

## Projects  (scope: project:read / project:write)

```bash
nopm projects ls                             # list all projects
nopm projects get <id>                       # fetch one project
nopm projects create --name "Network Modernisation" --code NBC-H [--program <p>] [--rag green] [--phase planning] [--start 2025-01-01] [--target 2025-12-31]
nopm projects update <id> --rag amber --pct 40
nopm projects lock   <id> [--reason "Approved baseline"]
nopm projects unlock <id>
nopm projects rm     <id>                    # hard-delete (project:write)
```

## Tasks  (scope: task:read / task:write / task:delete:request)

```bash
nopm tasks ls     --project <projectId>      # list a project's tasks
nopm tasks get    <taskId>                   # fetch one task
nopm tasks create --project <id> --name "Cutover dry-run" [--priority high] [--status-type started] [--milestone <id>] [--due 2025-06-30]
nopm tasks update <taskId> --pct 50 --status-type completed
nopm tasks rm     <taskId> --reason "superseded"   # MAKER — creates a pending deletion request
```

## Four-eyes deletion governance

```bash
nopm approvals                               # list pending deletion requests
nopm approvals --status all                  # all statuses
nopm approve <requestId>                     # CHECKER (must be a different token with task:delete:approve)
nopm approve reject <requestId> [--reason <why>]
```

## Audit log & discovery

```bash
nopm audit [--limit 20] [--page 1] [--target-type task] [--action task.create] [--actor-id <id>]
nopm search q "kanban"                       # full-workspace search
nopm timeline                                # Mainline portfolio graph summary (--json for the full graph)
nopm openapi                                 # operation index from the live spec (--json for the full spec)
```

Every module (risks, issues, clashes, resources, allocations, time, budget, expenses, documents, decisions, changes, rebaselines, notifications, reports, tokens) has its own command group — run `nopm help` for the full catalogue.

Every request sends `X-NoPM-Client: cli`, so the resulting audit_log rows are tagged `channel: cli` (R-82, `GET /audit?channel=cli`) — provenance only, never an authorization input; token identity stays authoritative.

## Global flags

| Flag | Effect |
|------|--------|
| `--json` | Machine-readable JSON output (any command) |
| `--curl` | Print the equivalent curl command instead of sending the request (token masked as `$NOPM_TOKEN`) |
| `--help` / `-h` | Usage for a command group — never fires an API call |
| `--page <n>` | Pagination (list commands) |
| `--limit <n>` | Page size (list commands) |
| `--flag=value` | Alternative syntax for values that start with `--` |

## Tests

```bash
cd cli && npm test           # node --test — parseFlags/die/out units + per-command URL/body contracts
```

## Architecture

```
cli/
  nopm.mjs              dispatcher — dynamic-import commands/<group>.mjs; central --help/--version
  lib/
    api.mjs             loadConfig/saveConfig/api/out/parseFlags/die (CliError, --curl dry-run)
  commands/             24 command groups, one file each (describe + usage + run)
  test/
    cli.test.mjs        contract tests with a stubbed ctx.api — no network
```

Four-eyes by design: a `maker` token can *request* a task deletion but cannot approve it; a separate `checker` token (`task:delete:approve`) commits it. Every call lands in the audit log.

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
nopm projects create --name "Network Modernisation" --code NET-MOD [--program <p>] [--rag green] [--phase planning] [--start 2025-01-01] [--target 2025-12-31]
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

## Optimistic concurrency

`projects`, `tasks`, `milestones`, `risks`, and `issues` support opt-in optimistic
concurrency (R-90) on `update`: pass `--expected-updated-at <iso>` and the API
rejects the write with `412` if the record changed since you read it, instead of
silently overwriting someone else's edit.

```bash
nopm tasks get <id> --json                                        # copy "updated_at" from the output
nopm tasks update <id> --status-type completed \
  --expected-updated-at 2026-09-07T08:12:44.031Z                  # fails 412 if it's stale
```

Omitting the flag preserves today's last-write-wins behavior exactly. A `412` prints:

```
✗ Precondition failed: the record changed since you loaded it (current updated_at: <value>). Re-run with --expected-updated-at <value> after reviewing.
```

Under `--json`, the raw error body (including `current_updated_at`) is printed instead, for scripted retries.

## Four-eyes deletion governance

```bash
nopm approvals                               # list pending deletion requests
nopm approvals --status all                  # all statuses
nopm approve <requestId>                     # CHECKER (must be a different person with task:delete:approve; a token counts as the human who created it)
nopm approve reject <requestId> [--reason <why>]
nopm review                                  # everything waiting on a person: deletions, change requests, rebaselines — and whether YOU may decide each
nopm review --kind rebaseline,change_request  # narrow by kind (read-only; deciding stays with the commands above / the console)
```

## Audit log & discovery

```bash
nopm audit [--limit 20] [--page 1] [--target-type task] [--action task.create] [--actor-id <id>]
nopm search q "kanban"                       # full-workspace search
nopm timeline                                # Mainline portfolio graph summary (--json for the full graph)
nopm openapi                                 # operation index from the live spec (--json for the full spec)
```

Every module (risks, issues, clashes, resources, allocations, budget, expenses, documents, decisions, changes, rebaselines, notifications, reports, tokens) has its own command group — run `nopm help` for the full catalogue.

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
| `--expected-updated-at <iso>` | Optimistic concurrency on `update` (projects/tasks/milestones/risks/issues, R-90) — 412 instead of overwriting a stale record |

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
  commands/             27 command groups, one file each (describe + usage + run)
  test/
    cli.test.mjs        contract tests with a stubbed ctx.api — no network
```

Four-eyes by design: a `maker` token can *request* a task deletion but cannot approve it; a separate `checker` token (`task:delete:approve`) commits it. Every call lands in the audit log.

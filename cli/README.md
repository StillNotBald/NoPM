# `nopm` CLI

Drive NoPM from your terminal — or hand it to your AI agent. Scoped Bearer token, documented endpoints, `--json` for machine output.

```bash
# point at your instance + save a scoped token (shown once when minted)
node nopm.mjs auth set-token npm_xxx --url https://stillnotbald.com
```

## Auth

```bash
nopm auth set-token <token> [--url <url>]   # save your scoped PAT
nopm whoami                                  # show actor + scopes
```

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

## Audit log  (scope: audit:read)

```bash
nopm audit [--limit 20] [--page 1] [--target-type task] [--action task.create] [--actor-id <id>]
```

## Global flags

| Flag | Effect |
|------|--------|
| `--json` | Machine-readable JSON output (any command) |
| `--page <n>` | Pagination (list commands) |
| `--limit <n>` | Page size (list commands) |

## Architecture

```
cli/
  nopm.mjs              dispatcher — dynamic-import commands/<group>.mjs
  lib/
    api.mjs             loadConfig/saveConfig/api/out/parseFlags/die
  commands/
    auth.mjs            set-token
    whoami.mjs          GET /api/me
    projects.mjs        ls/get/create/update/lock/unlock/rm (EXEMPLAR)
    tasks.mjs           ls/get/create/update/rm
    approvals.mjs       ls (GET /api/deletion-requests)
    approve.mjs         approve / reject (POST /api/deletion-requests/:id/{approve,reject})
    audit.mjs           ls (GET /api/audit)
```

Four-eyes by design: a `maker` token can *request* a task deletion but cannot approve it; a separate `checker` token (`task:delete:approve`) commits it. Every call lands in the audit log.

# `nopm` CLI

Drive NoPM from your terminal — or hand it to your AI agent. Scoped Bearer token, documented endpoints, `--json` for machine output. The same surface an agent uses over plain HTTP.

```bash
# point at your instance + save a scoped token (shown once when minted)
node nopm.mjs auth set-token npm_xxx --url https://stillnotbald.com

nopm whoami                                   # actor + scopes
nopm projects create --name "Network Modernisation" --code NBC-H
nopm projects ls
nopm tasks create --project <id> --name "Cutover dry-run"
nopm tasks rm <taskId> --reason "superseded"  # MAKER — creates a pending request
nopm approvals                                # pending deletion requests
nopm approve <requestId>                       # CHECKER (must be a different token)
nopm audit --limit 20                          # tail the immutable audit log
```

Four-eyes by design: a `maker` token can *request* a task deletion but cannot approve it; a separate `checker` token (`task:delete:approve`) commits it. Every call lands in the audit log.

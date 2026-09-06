# NoPM

**A lite, API-first project-management tool your AI agent operates** — like the `aws` / `supabase` / `hubspot` CLIs, but for project governance. NoPM bundles no LLM; *your* agent (Claude Code, Cursor, Copilot, any MCP client) drives it over a documented REST API + scoped token.

**Positioning:** NoPM does not replace Jira, Slack, or Teams; it is the governed record beside them. Lite and fast, not ClickUp.

The differentiator is **institutional governance built into the data layer**: an immutable audit log, scoped Bearer tokens, and maker-checker (four-eyes) approval on destructive actions — enforced by the database, not bolted onto the UI.

> Portfolio proof-piece. Live at **stillnotbald.com** · [Case study](https://stillnotbald.com/case-study) · [OpenAPI](https://stillnotbald.com/api/openapi.json) · [llms.txt](https://stillnotbald.com/llms.txt)

## Three agent surfaces, one governed API

| Surface | Where | What it gives an agent |
|---|---|---|
| **REST API** | 82 documented endpoints, [OpenAPI 3.1](https://stillnotbald.com/api/openapi.json) + [llms.txt](https://stillnotbald.com/llms.txt) (both spec-coverage drift-tested) | Everything — every mutation audited, scopes enforced per request |
| **`nopm` CLI** | [`cli/`](cli/) — zero dependencies, contract-tested | 26 command groups, `--json` machine output, `--curl` dry-run |
| **MCP server** | [`web/mcp/`](web/mcp/) + root [`.mcp.json`](.mcp.json) | 24 tools over stdio and Streamable HTTP; schemas lock-tested against the API's Zod validators |

The in-app **BYOK assistant** uses the same registry as the MCP server: your own OpenAI/Anthropic/Google/OpenRouter key (AES-256-GCM at rest) drives NoPM through an ephemeral scoped token — audited as a token actor, structurally unable to hold an approve/admin scope.

## Start here

| You want to… | Go to |
|---|---|
| Understand what this is and why | [Case study](https://stillnotbald.com/case-study) — or `web/src/app/case-study/page.tsx` |
| See the requirements + status | [`requirements/REQUIREMENTS.md`](requirements/REQUIREMENTS.md) (canonical R-IDs) |
| Trace a requirement to code + tests | [`requirements/TRACEABILITY.md`](requirements/TRACEABILITY.md) (RTM, CI-verified) |
| Read an architectural decision | [`docs/adr/`](docs/adr/) |
| See how each wave was built | [`sprint-log/`](sprint-log/) — dated receipts, per wave |
| Learn the console UI (operator / admin / agent surfaces) | [`user-manual/README.md`](user-manual/README.md) |
| Drive it from a terminal | [`cli/README.md`](cli/README.md) |
| Connect an MCP client | [`web/mcp/README.md`](web/mcp/README.md) |
| Check project health | `npm run health` (RAG dashboard, no network) |

## Layout
```
NoPM/
├─ web/            Next.js 16 app — API routes, console UI, MCP server, migrations
├─ cli/            nopm CLI (zero deps; talks only to the public REST API)
├─ requirements/   REQUIREMENTS.md (canonical) + TRACEABILITY.md (RTM)
├─ sprint-log/     dated build receipts
├─ docs/adr/       architectural decision records
├─ scripts/        governance gates: rtm-verify, commit-gate, health, setup-hooks
└─ .githooks/      pre-commit (leak gate) + pre-push (full verify) — installed by npm install
```

## Develop
```bash
npm install --prefix web      # deps (also installs the git hooks)
npm run dev                   # web app on :3000
npm run migrate               # apply SQL migrations (set DB_URL first)
npm run test                  # vitest — unit + governance-invariant suites
npm run health                # one-command RAG read on requirements/RTM/tests/gates
```
Secrets live in `web/.env.local` (gitignored). See `web/.env.example`.

## The governance gates travel with the clone

- **pre-commit** — leak gate over staged files (hashed confidential-token blocklist + secret-filename check)
- **pre-push** — typecheck, full test suite, RTM integrity, generated-metrics freshness, CLI contract tests
- **CI** — all of the above plus full-tree name scan, gitleaks (full history), dependency audit, and a weekly authenticated page-render smoke against the live site
- **Proof metrics are generated, not typed** — the case-study numbers come from `web/scripts/gen-metrics.mjs` (RTM + vitest + route tree); CI fails if they drift

## Operations & governance docs
- Go-live / cutover procedure: [`CUTOVER/`](CUTOVER/README.md) — install, deploy, rollback, backup-restore, go/no-go, dry-run records
- How the pieces fit together: [`system_architecture.md`](docs/architecture/system_architecture.md)
- What is live right now (the production snapshot): [`PROD_DOOR.md`](docs/ops/PROD_DOOR.md)
- Test evidence tree: [`testing-log/`](testing-log/README.md)
- Console user manual (operator / admin / agents): [`user-manual/README.md`](user-manual/README.md)

## Stack
Next.js 16 · TypeScript · Tailwind v4 · Supabase (Postgres + Auth + RLS) · Vercel + Cloudflare DNS.

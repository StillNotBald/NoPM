# NoPM — web app

The Next.js 16 application: REST API, console UI, MCP server, and migrations. Repo-level docs (requirements, RTM, ADRs, sprint log) live one directory up — start at the [root README](../README.md).

## Run it

```bash
npm install                # also installs the repo git hooks (prepare)
cp .env.example .env.local # fill in your Supabase project values
npm run dev                # http://localhost:3000
```

You need a Supabase project (free tier works): create one, copy the URL + anon key + service-role key into `.env.local`, then:

```bash
npm run migrate            # applies web/supabase/migrations/ in order (uses DB_URL)
npm run seed:all           # optional: demo workspace, projects, clash, budget, approvals
```

## Verify

```bash
npm test                   # vitest — unit + governance-invariant suites
npx tsc --noEmit           # typecheck
npm run rtm:verify         # requirements ↔ RTM ↔ on-disk code paths
node scripts/gen-metrics.mjs --check   # case-study proof metrics ↔ reality
node scripts/auth-smoke.mjs            # authed page-render rehearsal (needs .env.local)
```

## Layout

```
web/
├─ src/app/api/        every action is a documented route.ts (wrapped by route())
├─ src/app/(console)/  the operator console (consumes the same API)
├─ src/lib/            auth guards, audit writer, assistant loop, EVM, reports
├─ mcp/                MCP server + the shared agent tool registry (tools.mjs)
├─ supabase/migrations/ SQL, applied in filename order by npm run migrate
└─ scripts/            seed chain, gen-metrics, auth-smoke, mcp-smoke, ops
```

## Governance invariants (what the tests actually lock)

- Every mutation writes exactly one immutable `audit_log` row (`writeAudit`, fail-closed).
- One JSON contract: success `{ data }`, failure `{ error }` (+ `fields`), correct status codes.
- Scoped `npm_` PATs, SHA-256 hashed at rest, shown once; token callers always workspace-filtered.
- Maker-checker on task deletion — approver ≠ requester, enforced in scope + API + DB CHECK.
- Agent tool schemas lock-tested against the API's Zod validators; OpenAPI bodies generated from the same validators; `llms.txt` coverage-locked to the spec.

## MCP server

`npm run mcp` starts the stdio server (needs `NOPM_TOKEN`). See [mcp/README.md](mcp/README.md); a cloned repo also has a root `.mcp.json` for zero-config Claude Code pickup.

# Contributing to NoPM

NoPM is a portfolio proof-piece with an unusual constraint: **the discipline is the product**. Contributions are welcome, but they go through the same governance the codebase demonstrates.

## The rules the repo enforces on you

Running `npm install` (root or `web/`) installs the checked-in git hooks:

- **pre-commit** — leak gate over staged files (hashed confidential-token blocklist + secret-class filename check).
- **pre-push** — typecheck, the full vitest suite, RTM integrity, generated-metrics freshness, and the CLI contract tests. CI runs the same gates plus gitleaks and a dependency audit.

## The same-commit discipline

- **Requirements**: every behavior change maps to an R-ID in `requirements/REQUIREMENTS.md`. Update the matching row in `requirements/TRACEABILITY.md` **in the same commit** (`npm run rtm:verify` gates it).
- **Proof metrics**: if you add tests, endpoints, or requirements, regenerate `web/src/lib/metrics.gen.json` (`cd web && npm run gen:metrics`) in the same commit — CI fails on drift.
- **ADRs**: architectural or irreversible decisions get a `docs/adr/NNNN-*.md`.

## Ground rules for changes

- The API layer is the product: new actions are documented `route.ts` endpoints wrapped in `route()`, returning the `{ data }` / `{ error }` envelope. The UI and CLI only call the API.
- Every mutation writes exactly one audit row (`writeAudit`, fail-closed). No silent writes.
- Agent surfaces (assistant + MCP) share `web/mcp/tools.mjs`; new tools must pass `tools-zod.test.ts` and `tools-openapi.test.ts`.
- Stack additions are ask-first — open an issue before introducing a dependency.
- No bundled LLM, no real email send, and nothing in the "Do NOT build" list in `CLAUDE.md` without an issue first.

## Quick check before a PR

```bash
npm run health             # RAG dashboard over requirements/RTM/tests/gates
cd web && npm test && npx tsc --noEmit && npm run rtm:verify
```

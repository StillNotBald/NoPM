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

## Before you open a PR

The pull request template already lays out the checklist: one audit row per mutation, workspace-scoped queries for token callers, a required scope on every endpoint, the `{ data }`/`{ error }` contract with correct status codes, the same-commit RTM update, tests, and OpenAPI/`llms.txt`/MCP registry updates for new routes. Read it before you start, not after you open the PR — most review friction comes from one of those items being missed, and they are easier to satisfy while writing the change than to retrofit afterward. The template also lists what not to open a PR for (weakening audit immutability, workspace isolation, or self-approval protection, bundling an LLM, and a few others); if your change touches one of those, open an issue first instead of a PR.

## Issue templates

Use the issue template that matches what you want:

- **Bug report** — something doesn't work as documented.
- **Feature request** — a lighter-weight suggestion, no business justification required.
- **Change request** — a fully-scoped ask (who's asking, why it matters, what "done" looks like), whether you want it as a free contribution or a paid engagement. See [`docs/guide/05-getting-help-and-paid-services.md`](guide/05-getting-help-and-paid-services.md) for the paid path.

Security vulnerabilities do not use an issue template at all — see [`docs/SECURITY.md`](SECURITY.md) for the private reporting channel.

## Licensing of contributions

NoPM is licensed under Apache License 2.0. There is no separate contributor license agreement: under Apache-2.0 §5, unless you state otherwise in writing, any contribution you submit for inclusion is licensed to the project under the same terms as the rest of the codebase (inbound = outbound). You don't sign anything extra or hand over separate rights beyond what the license already grants everyone. If you're contributing code you didn't write yourself, make sure you have the right to submit it under Apache-2.0 before opening the PR.

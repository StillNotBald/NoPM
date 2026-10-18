# ADR 0006 — Atomic four-eyes deletion + scope registry + isolation guard

- **Status:** Accepted
- **Date:** 2026-06-09

## Context

The state-of-NoPM review (`docs/research/STATE-OF-NOPM-2026-06-09.md`) surfaced three P0 governance-integrity gaps that undercut the project's central claims:

1. **Audit non-atomicity (worst case: the four-eyes delete-approve route).** `deletion-requests/[id]/approve/route.ts` performed four separate non-transactional writes — delete task → update request → `writeAudit('task.delete')` → `writeAudit('deletion_request.approved')`. A process crash between the delete and the audit inserts could leave a **committed deletion with zero audit rows** and the request still `pending`: the governance showpiece losing its own evidence. There was also a check-then-act race (two approvers could both pass the `pending` check).
2. **Unvalidated PAT scopes.** Token scopes were free-form strings; a token minted with a bogus scope (e.g. `task:teleport`) was accepted silently and simply never matched — the "scoped token" guarantee was weaker than claimed.
3. **RLS-bypass on the agent path.** Token callers use the service-role admin client (RLS off); isolation relies on a manual `workspace_id` filter in every handler, with no automated catch for a missed one.

## Decision

1. **Atomic deletion via a Postgres function.** Migration `0020` adds `nopm_commit_task_deletion(...)`, which performs the delete + request-commit + **both** audit inserts inside one transaction (a function body is atomic) and locks the request row `FOR UPDATE` to serialize concurrent approvals. Its guards (`NOT_FOUND` / `ALREADY_DECIDED` / `SELF_APPROVAL`) raise typed exceptions the route maps to 404 / 422 / 403. The route now calls the RPC instead of issuing four client writes. **A crash can no longer split a deletion from its audit; a double-approve can no longer race.** Verified: a committed approval writes exactly two audit rows; a rejected self-approval rolls everything back (task survives, zero audit rows).
   - *Why an RPC and not a transaction in the route:* the Supabase JS client issues each `.from()` call as a separate PostgREST request — there is no client-side multi-statement transaction. A `SECURITY`-default PL/pgSQL function is the idiomatic way to get one atomic unit. This route is the highest-stakes one; the same pattern can be extended to other multi-write governed mutations later.
2. **Central scope registry.** `src/lib/auth/scopes.ts` enumerates every `resource:action` scope the API enforces; `isValidScope()` also accepts `<resource>:*` / `*` wildcards. The token-mint schema (`api/tokens/_schema.ts`) now rejects any scope not in the registry at creation time (422). The assistant's `TOOL_SCOPES` are asserted (by test) to be a strict subset.
3. **Workspace-isolation guard test.** `src/lib/auth/workspace-isolation.test.ts` statically asserts that **every** route using the admin client references a scoping token (workspace or caller identity). It is a backstop, not a proof — but a future route that calls the admin client with no scoping now **breaks CI**. (The deeper fix — running token callers under RLS via per-request claims instead of the service-role client — remains a Phase-1.5 candidate.)

## Consequences

- The "immutable audit trail" and "four-eyes" claims are now airtight for the deletion path: atomic, race-free, evidence-preserving. The generic after-commit audit pattern still applies to other single-write mutations (lower risk; the bound is documented in the state review).
- The "scoped token" claim is now enforced at the boundary, not just honored by convention.
- Test suite grew 102 → 119 (scope registry, EVM pure-function math, the isolation guard).
- New surface area: one Postgres function (governed by the same migration discipline) and a registry that must be kept in sync as scopes are added — the subset test will catch assistant drift, and the isolation test will catch unscoped routes.

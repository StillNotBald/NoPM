# UC-15 · Trust Center audit review

**Goal:** Give a human reviewer (or an auditor, or a hiring manager evaluating the product) one place to see every governed action in the workspace, filterable, with a stated proof of the invariants that back it.

**Actors:** Admin, Approver, Viewer (read-only access is enough — the Trust Center is meant to be reviewable by anyone with `audit:read`, including a viewer).

**Preconditions:** At least one mutation has happened in the workspace (in practice, always true after seeding).

**Trigger:** Someone wants to verify a specific change happened, was done by whom, and wasn't silently altered afterward, or just wants to browse recent activity.

## Main flow

1. UI: `/trust` — the newest 50 rows of `audit_log`, each showing the action (e.g. `task.create`, `deletion_request.approve`, `project.delete`), the actor (a human `user` or a scoped `token`), the target, and both a relative and absolute timestamp. Action strings are color-coded by verb: create = accent, approve = success, reject = warning, delete/revoke = danger.
2. API: `GET /audit` (scope `audit:read`) — filters: `?target_type`, `?target_id`, `?action`, `?actor_id`, `?channel` (one of `ui|api|cli|mcp|assistant`, unrecognized values ignored), `?since` (ISO 8601, `422` if unparsable), `?after_id` (uuid of a row already seen, `404` if absent from the caller's workspace), `?order` (`asc|desc`, default `desc`, `422` otherwise). `since` and `after_id` combine.
3. UI filter bar (`?target_type&target_id&action&channel`, a plain `<form method="get">`, no client JS) sits above the timeline; a "Clear" link resets it. Per-object "History" links (task detail panel, risk/issue detail headers, project header actions) deep-link straight into `/trust?target_type=<type>&target_id=<id>`.
4. A "What this proves" card states four claims: retention (rows are kept forever, DB triggers reject `UPDATE`/`DELETE` on `audit_log` for every role, including admins), provenance (actor, declared `channel`, and `request_id` on every row), fail-closed honesty (deletion/invite commits write their audit row in the same transaction as the change; other writes persist first and error if the audit write fails), and that the export itself is audited.
5. The CSV export href on `/trust` always carries whatever filters are active on screen, so the download matches the on-screen view exactly.

## Alternate and exception flows

- **`since` unparsable** → `422`.
- **`after_id` not found in the caller's workspace** → `404` (never leaks whether the id exists in a different workspace).
- **`order` not `asc`/`desc`** → `422`.
- **Missing `audit:read`** → `403`.
- **Blocked-attempt rows** — a rejected write still writes an audit row, fail-soft: lock-blocked writes (`task.update.blocked`, `task.create.blocked`, `task.delete_request.blocked`) and rate-limited requests (`rate.limited`) both appear in the same stream, distinguished by outcome, not hidden. This is deliberate: a pattern of denied attempts (an agent hammering a locked schedule, a script retrying past its budget) is a signal worth seeing.

## Postconditions

- No state changes as a result of reading; the CSV export from this page is the one action here that itself writes an `export.csv` audit row (UC-14).

## Reporting and evidence

- This use case is itself the primary reporting surface for governance — it is designed to be the artifact a reviewer points to as proof the audit/maker-checker backbone is real, not asserted.
- The Actor-types glossary card on `/trust` explains the `channel` chip: caller-asserted provenance, never an authorization input (token/session identity stays the sole authoritative actor).

## Traceability

- R-IDs: R-35 (Trust Center — live audit stream + per-entity provenance), R-86 (Trust Center buyer view — filters, per-object history, retention statement, tokens page scope-registry derivation), R-01 (immutable audit log), R-82 (audit provenance: channel + request id).
- Key files: `web/src/app/(console)/trust/page.tsx`, `web/src/app/api/audit/route.ts`, `web/src/app/api/audit/_query.ts`, `web/src/lib/audit/write.ts`, `web/src/lib/audit/channel.ts`.
- Tests: `web/src/lib/audit/immutability.test.ts` (asserts the append-only triggers are created exactly once and never dropped/disabled by any later migration); `web/src/lib/audit/coverage.test.ts` (every mutating route calls `writeAudit` or is on an explicit, reason-commented allowlist verified both ways).

## Open questions

None outstanding; this use case was verified directly against `docs/guide/03-how-governance-works.md`, `user-manual/operator/04-approvals-and-trust.md`, and the R-86 requirement text.

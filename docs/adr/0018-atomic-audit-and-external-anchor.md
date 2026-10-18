# ADR 0018 — Atomic audit for every write, and an external anchor for the audit chain

- **Status:** Accepted (change request CR-2026-10-18-02; owner decision Q8 "Different DB" in CR-2026-10-18-01; assumptions A9 to A12; owner decisions D8, D9, D15 and D19 are built as their recommended defaults until the owner answers)
- **Date:** 2026-10-18
- **Builds on:** ADR 0003 (audit cascade), ADR 0006 (atomic deletion and the scope registry), ADR 0016 (audit-gap programme), ADR 0017 (approval tiers)
- **Closes:** audit gaps M1 (atomic audit), G8 (deletion by request, remaining registers) and the tamper-evidence half of A7 (the hash chain had no outside witness)
- **Requirements:** R-161 to R-170 (atomic writes, the anchor), R-176 and R-177 (deletion by request for five more registers)

## Context

Cycle 1 made the audit log tamper-evident inside the database. Every row carries `prev_hash`, `row_hash` and `chain_seq`, and `GET /api/audit/verify` recomputes the chain. Two weaknesses were left, and the v2 positioning audit rated both PARTIAL.

| Gap | What the audit found |
|---|---|
| M1 | 24 handlers still wrote the change first and the audit row second. A failure between the two left a change with no trail. |
| A7 and Q8 | A database owner who rewrites a row and recomputes every later hash passes the check. The head hash had to be kept outside the database, and nothing did that. |
| G8 | Programs, sprints, resource members, allocations and clashes were still direct deletes. |

The brief is "leaves the evidence auditors ask for". An auditor needs two things: no change without its row, and a copy of the chain head that the primary database's administrator cannot rewrite.

## Decision

### 1. One transaction for every write and its audit row (R-161 to R-165)

The 24 remaining handlers move onto the atomic path. Eight are governance writes, twelve are security and integration writes, and four are unattended jobs.

- A shared SQL helper, `nopm_audit_insert` (migration 0107), inserts exactly one `audit_log` row with the same columns as the existing wrapper. It never sets the hash columns; the chain trigger fills them. It is executable by the service role only, and it accepts a user, a connector or the system actor.
- Only two handlers fit the generic wrapper. The other 22 use a dedicated function per transition (for example `nopm_request_deletion`, `nopm_mfa_challenge`, `nopm_link_identity`, `nopm_snapshot_run`). Each function writes the change and calls the helper in the same transaction.
- Nothing visible changes (A12). Every audit action name, every `before` and `after` shape, every status code and every response body stays as it was. Auditors' tooling and the audit pack depend on that.
- Two-step sign-in keeps its attempt counter and its one-time code burn outside the audit transaction (D13). A failing audit write must never give a free guess, so the counter is not rolled back.
- Unattended jobs are converted too (D14). The test is "no automatic change without its audit row". Scheduled rows carry a system actor (`system:snapshots`, `system:weekly-report`) and no human principal.
- A cron run that cannot write its audit row changes nothing and answers with the failure. The next tick retries.

### 2. The anchor model (R-168 to R-170, Q8)

A second Postgres database, reached by `NOPM_ANCHOR_DB_URL`, holds one append-only table, `audit_anchors`. A record is `(workspace_id, chain_seq, head_hash, row_count, anchored_at)`. The key is `(workspace_id, chain_seq)` because the chain is per workspace (A11).

| Question | Decision |
|---|---|
| What is stored | Hashes, positions and counts only. No business data, no names, no amounts. |
| How it is reached | The `pg` package already approved for the migration runner, now also at runtime, typed by a local shim. No new package (A9). It is imported in one file behind a small interface (`AnchorSink`: put, latest), with a no-op implementation. |
| Connection | One short-lived connection per call, TLS always on, 5 second connect and statement timeouts. TLS is off only for a loopback host together with an explicit rehearsal flag. |
| Database role | **Insert and select, never update or delete** (D12). Triggers and grants make the table append-only. A write-only role cannot be read back, and the comparison needs the read. |
| Where it lives | A separate project under a separate login, so a stolen primary-database admin cannot rewrite the anchor (D9, recommended default). The owner creates it. |
| When it is written | Daily on the existing cron tick, and on every successful `GET /api/audit/verify` (D11). A head that is already anchored is skipped. |
| Order | Verify, record the verify result in its own `audit.verified` row, then anchor the head that includes that row. |
| Read-back | Every write is read back and compared before it counts as anchored. |
| Unset | With the variable unset nothing is written, nothing is read, nothing throws. Every surface says "Not anchored". |

`GET /api/audit/verify` compares the live chain with the newest anchor and reports one of five states.

| State | Meaning |
|---|---|
| `not_anchored` | Nothing is configured, or this workspace was never anchored. |
| `anchored` | The live row at the newest anchored position has the anchored hash, and it is the head. |
| `behind` | Same, with newer rows since. Informational. |
| `mismatch` | Rows were removed or rewritten since the anchor. `ok` becomes false even if the chain itself is sound. |
| `unreachable` | The copy could not be read or written. Nothing else is affected. |

`chain_ok` is the plain chain result. `ok` is `chain_ok` and no mismatch. `all_clear` is true only when `ok` is true and the state is neither `mismatch` nor `unreachable`. The word "anchored" is reported only after a successful comparison. No route anchors on demand.

### 3. Fail open for writes, loud for claims (D8)

A business write never waits for an outside database. An anchor outage cannot stop anyone working. The price is that the system must never claim more than it knows.

- A failed anchor write or read records a failure streak in a bookkeeping table (`audit_anchor_receipts`, one row per workspace, row-level security on, no write grant for browser roles). The table drives the display and the streak memory. It is never used to decide a comparison.
- One `audit.anchor_failed` row is written per failure streak. One `audit.anchor_mismatch` row is written per mismatch streak. Neither is written per verify or per tick.
- The Trust Center never shows a green anchor line it did not check. It shows "Anchored", "Anchored, N rows behind", "Not anchored" with a line on how to turn it on, a red "Anchor mismatch" alert, or an amber "Anchor unreachable since".
- Nothing is anchored while the state is `mismatch` or the verify failed. A good copy is never overwritten with a bad head.
- The audit pack cover prints an anchor line next to the chain head line.

The alternative, failing closed on verify or audit-pack export, would let an outside outage block an audit. It stays available as a later change: a staleness limit after which audit-pack export refuses.

### 4. No anchor row on routine success (A10)

A successful anchor writes no `audit_log` row. A row per anchor would move the head and chase itself, and the anchor table is already the evidence. Exactly three events write a row:

| Action | Written when |
|---|---|
| `audit.anchored` | The first anchor of a workspace, or the first success after a failure streak. Written after the outside copy confirmed. |
| `audit.anchor_failed` | Once per failure streak. |
| `audit.anchor_mismatch` | Once per mismatch streak. |

Every `audit.verified` row also records the anchor state before that check, so the trail itself shows the anchor state at each verify.

### 5. Deletion by request for five more registers (R-176, R-177, D15, D16, D19)

Programs, sprints, resource members, allocations and clashes join the seven kinds that already delete by request.

- `DELETE` on each raises a deletion request and answers **202 with the request**. It answered 204 with no body before. This is the one contract change in the release (D19) and is flagged to the owner.
- The tier is fixed by the kind and cannot be routed in Settings (D15). A program is high risk and only an admin approves it. A sprint, a resource member, an allocation and a clash are normal. A program is approved with `project:delete:approve`; the other four with `task:delete:approve`. No new approve scope exists, and no wildcard grants one.
- The five request scopes are new (`program:delete:request` and the others). A token minted with the old write scope keeps the right to ask. Nobody gains the right to approve.
- A request for a program, a sprint or a resource member records how many children it has, and approval is refused with `children_changed` if the number moved. A resource member with archived timesheets is refused at request and again at approval.
- A delete of any clash, including one the system created, needs a request (D16). Resolving a clash is a status change and is unaffected.
- Migration 0113 (before the deploy) widens the checks and adds the commit functions. Migration 0114 (after the deploy) attaches the delete-refusing trigger to the five tables. Between the two files the old and the new build both work. Every function that can cascade into those tables sets the deletion flag, and a test scans every migration for any other function that deletes from them.
- No chat approval card is sent for these kinds.

## Consequences

- Between the 0114 trigger and the end of time, a direct delete on those five tables fails by design, as for the earlier seven. Seed scripts must go through a request or run in replica mode.
- Agents and scripts that expected 204 from the five routes must read the new body.
- The audit chain is now provable against a database owner, but only for workspaces whose anchor was set up. An unset variable is honest ("Not anchored") and costs nothing.
- The anchor database is one more thing for the owner to run. The free tier is enough: one row per workspace per day.
- A mismatch is an incident, not a warning. `CUTOVER/13-AUDIT-ANCHOR.md` says what to do.

## Options rejected

| Option | Why not |
|---|---|
| Fail closed on writes when the anchor is down | A mutation would wait for an outside system. Not recommended. |
| One audit row per anchor | The row moves the head, so the next anchor is always behind. |
| A write-only anchor role | The comparison could not read the anchor back. |
| A manual force-anchor route | It would let a session decide what the outside copy says. The daily job and a successful verify are the only writers. |
| Make the five new kinds routable in Settings tiers | A policy-shape change to the validator and card. Left as a follow-up if the owner wants it. |
| Keep 204 and add five new request routes | Breaks the one-`DELETE`-per-entity pattern. |

## Where it lives

- Change request: `sprint-log/2026-10-18_m1-closeout/CHANGE-REQUEST.md`. Plan: `sprint-log/2026-10-18_m1-closeout/PLAN.md`.
- Atomic helper and functions: migrations 0107 to 0111. Anchor bookkeeping: 0112. Deletion by request: 0113 and 0114.
- Anchor code: `web/src/lib/audit/anchor/`. Second-database schema: `web/anchor-db/001_audit_anchors.sql`. Setup and rollback: `CUTOVER/13-AUDIT-ANCHOR.md`. Release order: `CUTOVER/14-WAVE5-RELEASE.md`.
- Use cases: UC-33 (verify the chain, now with the anchor) and UC-35 (deletion by request for the remaining registers).

# ADR 0010 — F3 killed as a wave; Wave-3 infra becomes documentation, not code

- **Status:** Accepted (owner, 2026-08-15)
- **Date:** 2026-08-15

## Context

`sprint-log/2026-08-15_feature-wave-f2b/` (and the F2c mini-wave planning that followed it) worked from a lite-register draft (`nopm-lite-register-draft.md`, not checked into the repo — a planning artifact) that grouped the remaining backlog into waves F1/F2/F3 by rough priority. F3 was the lowest-priority tranche: refinements and extensions layered on capabilities F1/F2 already ship, plus the Wave-3 self-hosted infra commitment already on record (`requirements/devops-wave1/README.md` Decision 7; `CUTOVER/01-INSTALL.md` and `CUTOVER/04-BACKUP-RESTORE.md` "Self-hosted path — STUB" sections).

The owner reviewed F3 against this project's actual purpose — a live-hosted portfolio proof-piece for employers — and applied a single test to every row: **does building this change what a hiring manager sees?** Rows that only deepen or re-skin a capability the reviewer already saw demonstrated elsewhere fail that test. The owner's ruling (2026-08-15, this session): **kill F3 as a build wave.** Two of its rows were judged load-bearing enough to promote into the F2c mini-wave instead of being deferred outright (below); the rest are deferred, not deleted — this ADR is the record of which and why, so "we're not building this" is a decision with a paper trail rather than a silent drop.

Separately, the same review applied to the standing **Wave-3 infra commitment** (self-hosted `infra/` docker-compose + self-hosted backup script, Decision 7 above): the owner ruled it becomes **documentation only** — `docs/SELF_HOSTING.md` and `docs/DR_RUNBOOK.md` — with no docker-compose file and no backup/restore scripts shipped. Features-first; infra code that no reviewer will ever run is lower leverage than the documentation that proves the team thought it through.

## Decision

### 1. F3 rows: deferred, not built, this mini-wave

The register draft tags 10 rows `F3`. Two were promoted out of F3 into this mini-wave because the owner judged them load-bearing (see "Promoted" below), leaving **8 rows confirmed deferred**:

| L-id | Feature | Fails the hiring-manager test because... |
|---|---|---|
| L-14 | Workload group-by (program/project as a second dimension) | The workload chart itself (L-13, shipped F1) already proves "over-allocation is a picture, not a percentage." Grouping it by a second dimension is a power-user drill-down on a capability already demonstrated — not a new thing to see. |
| L-21 | Sprint carry-over (roll incomplete tasks forward in one action) | The sprint container, burndown and velocity chart (L-17/18/19/20, F2) already tell the "governed, time-boxed delivery" story end to end. Automating the rollover of leftover tasks is a convenience on top of that story, not a new chapter of it. |
| L-25 | Cumulative-flow diagram | A third chart type reading the same `audit_log` transition history that burndown (L-19) and velocity (L-20) already visualize. Depth on an already-proven data source, not new ground for a reviewer. |
| L-35 | Program-level board pack export | Extends the existing deck export (R-40) from project scope to program scope. "A governed export renders a real board pack" is already told at project scope — the program-scope variant is breadth, not a new capability class. |
| L-40 | Workspace default landing view | An admin-only settings toggle that is invisible to anyone evaluating the product from the outside — a demo visitor or reviewer never sees this control exist. |
| L-43 | Workload unit selection (hours / points / task count) | A unit-of-measure toggle layered on the already-shipped workload chart (L-13). Cosmetic flexibility, not new signal about the governance thesis. |
| L-44 | Workspace accent preset | Pure re-skin/branding control. L-37's personal appearance system (F1, shipped) already demonstrates the exact "closed preset registry, no free-form CSS" pattern this would reuse — a second instance of an idea already proven, not a new one. |
| L-51 | Starter project templates | Onboarding convenience. The first-run wizard (L-45, F2) and load-sample-data (L-52 — see "Promoted" below) already carry the full "empty workspace → populated in minutes" story without a template picker. |

**Provenance note (flagged, not resolved here):** the owner's verbal framing of this decision referred to "9 rows deferred." Re-deriving the set mechanically from the register draft's `F3` tags (10 rows) minus the 2 promoted below yields **8**, not 9 — this ADR records the 8 that are mechanically traceable to a tagged register row and flags the count discrepancy for reconciliation rather than inventing a ninth row to make the arithmetic match. If a 9th row was intended, it should be named explicitly and appended to the table above in a follow-up, not backfilled here without a citation.

### 2. Promoted out of F3 into this mini-wave (built, not deferred)

Two F3-tagged rows were judged load-bearing enough to build now rather than defer:

- **L-32 (period-close lock)** — promoted because a demo of the four-eyes timesheet-approval flow (L-31, F2, already shipped) is materially weaker without showing that an *approved* period actually stops changing — "historical cost stops changing" is the payoff line of the whole timesheet governance story, not an optional extra. Built as T1 of this mini-wave (R-76).
- **L-52 (load sample data)** — promoted because a hiring manager who lands on an empty seeded workspace sees nothing at all; sample data is the precondition for every other feature in this mini-wave (and most of F1/F2) being visible to a first-time visitor. Built as T2 of this mini-wave, extending the existing `R-52` seed.

(The governance-tour checklist, L-50, was also built this mini-wave as T4 (R-77) — it was already tagged `F1` in the register draft, not `F3`, so it is not part of the F3 deferral being recorded here; it is named in the mini-wave planning note alongside the two promotions above only because all three landed in the same build wave.)

### 3. Wave-3 infra: documentation, not code

The standing commitment (`requirements/devops-wave1/README.md` Decision 7) was: self-hosted `infra/` (docker-compose Supabase equivalent) + a self-hosted backup script + its drill, in Wave 3. That commitment is **not withdrawn** — it is fulfilled differently:

- **Shipped this mini-wave:** [`docs/SELF_HOSTING.md`](../SELF_HOSTING.md) (the self-host topology sketch, env matrix, migration path, and honest "not supported" list) and [`docs/DR_RUNBOOK.md`](../DR_RUNBOOK.md) (the executable-when-needed PITR restore drill + backup posture).
- **Not shipped, deliberately:** any `infra/` docker-compose file, any self-hosted backup/restore script. Both documents above say so explicitly and are marked accordingly ("DOCUMENTED, NOT SHIPPED").
- **Rationale:** infra code that would sit unrun in this repo (no self-hosted install has ever been stood up against it, per the honest gaps already on record in `CUTOVER/01-INSTALL.md` and `CUTOVER/04-BACKUP-RESTORE.md`) is not a proof-piece a hiring manager can evaluate the way a live, working feature is. The documentation *is* the deliverable that survives review — it demonstrates the same "thought through, not hand-waved" discipline as shipped code, at a fraction of the cost, and without shipping infrastructure code no one has verified against a real deployment.

## Consequences

- The 8 deferred F3 rows above remain in the register as backlog, unscheduled — nothing here deletes them, and any of them can be un-deferred by a future owner decision the same way L-32/L-50/L-52 were pulled forward into this mini-wave.
- `docs/SELF_HOSTING.md` and `docs/DR_RUNBOOK.md` are the closing artifacts of the standing Wave-3 infra commitment (Decision 7) — that commitment is now considered **fulfilled as documentation**, not outstanding as undelivered code. A future decision to actually ship self-hosted `infra/` code would be a **new, ask-first decision** (per the constitution's "new dependencies or hosting/infra dependencies" ask-first line), not a resumption of a still-open Wave 3.
- The provenance note in §1 (8 vs. the owner's stated 9) should be reconciled by whoever owns the next RTM/register pass — this ADR does not resolve it unilaterally.

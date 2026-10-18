# ADR 0016 — Audit-gap programme: build every gap the positioning audit rated open

- **Status:** Proposed (owner scope approved 2026-10-18; the eight assumptions in CR-2026-10-18-01 await an explicit yes or no)
- **Date:** 2026-10-18
- **Builds on:** ADR 0006 (atomic deletion), ADR 0007 (MCP server), ADR 0012 (integration hub), ADR 0013 (principal-aware four-eyes), ADR 0014 (approver roles), ADR 0015 (common-pattern defaults)
- **Change request:** CR-2026-10-18-01 (`sprint-log/2026-10-18_audit-gaps/CHANGE-REQUEST.md`)
- **Plan:** `sprint-log/2026-10-18_audit-gaps/PLAN.md`

## Context

The positioning audit (`_docs/directions-2026-10-17/NOPM_AUDIT_REPORT.md`, audited at commit 6fd8981) tested the product against the brief "Your PMO runs without you, and leaves the evidence auditors ask for". It rated each brief item BUILT, PARTIAL, MISSING or STILL PRESENT. Only one item per section rated BUILT. The gaps sit mostly in governance tiers, the evidence chain, unattended operation, and the agent surface.

The owner decided to build all the gaps rather than narrow the pitch. The change request lists them as A1 to A5 and A7, B1 to B3 and B5 to B7, G1 to G5, G7 and G8, M1 to M7, and K1 to K5 (K4 as a preset change only).

## Decision

### Build in four waves

Each wave ends with one review pass, one fix pass by the owning agents, the lead merging RTM rows, and the full test, typecheck, lint and commit-gate run. Every wave also carries an owner-visible changes block, a UAT plan a non-developer can run, and a phone-width (390 px) render of every new screen.

| Wave | Theme | Migrations | R-IDs | Items |
|---|---|---|---|---|
| 1 | Foundation: schema integrity, lean payloads, access review | 0088 to 0091 | R-127 to R-133 | M7, K3, K1, K2, K4, K5, A7, M5, M3 (export half), audit CSV columns |
| 2 | Change-request evidence chain | 0092 to 0094 | R-134 to R-139 | M2, B1, B2, M4, M3 (audit pack), B7 |
| 3 | Runs without the owner | 0095 to 0099 | R-140 to R-147 | M6, A3, A4, A5, B3, B6, G5, B5 |
| 4 | Governance tiers, deletion, atomic audit, work events | 0100 to 0105 | R-148 to R-153 | G1 to G4, G7, G8, M1, A1 |

### Numbering rules

| Kind | Rule |
|---|---|
| Migrations | Next free is 20261018000088. Each wave takes only its own range (0088 to 0105). No agent takes a number outside its range. |
| R-IDs | Next free is R-127. Each agent writes its rows to `sprint-log/2026-10-18_audit-gaps/rtm/<agent>.md`. The lead merges them into `requirements/REQUIREMENTS.md` and `requirements/TRACEABILITY.md`. |
| UAT IDs | Minted only in `UAT-log/01-FINDINGS.md`, by the lead, during UAT. |
| Owner-visible rows | Recorded per wave in `sprint-log/2026-10-18_audit-gaps/OWNER-VISIBLE.md`. |

### Owner assumptions awaiting confirmation

Each assumption is built as stated and flagged. The owner can change any of them without blocking the build.

| # | Assumption | Built as |
|---|---|---|
| 1 | Auto-approve on timeout (G3) exists but is off by default. It is allowed only on the routine tier, and an admin switches it on per workspace. | Settings flag, default off |
| 2 | "Mark implemented" (M2) is an explicit action by the requester or an approver. It is audited, and `implemented_at` must be at or after `decided_at`. This supersedes the earlier "remove implemented" answer. | CHECK constraint |
| 3 | Tier names follow the brief: routine, normal, high_risk, emergency, strategic. Default routing is listed in the change request and is editable in Settings. Currency threshold defaults to RM 50,000. | Settings defaults |
| 4 | `risks.category` is no longer accepted or returned. The column stays until a later release drops it. | API and form change |
| 5 | The one-click agent preset gains `risk:write`, `issue:write` and `project:write`. It never gains approve or decide scopes. | Preset change, owner-visible |
| 6 | GitHub events move only tasks whose `external_ref` matches. They never touch a locked project, and each acts as a connector actor with an audit row. | Route rules |
| 7 | Audit tamper evidence is a hash chain (`prev_hash`, `row_hash`) set by the insert trigger. There is no external anchor yet. | Trigger, verifiable by one query |
| 8 | Deletion by request extends to expenses, approved documents, risks, issues and milestones (G8). Tasks and projects already have it. | DB trigger refuses hard delete |

## Consequences

- **Schema growth.** Eighteen additive migrations (0088 to 0105). The one narrowing change is that `risks.category` stops being read or written.
- **New approval semantics.** Tier routing, timers and the emergency path change who can approve what. Every rule is enforced in the route and in the database, never only in the UI. Emergency changes get a 48-hour admin retro flag.
- **New API surfaces.** Handover report, audit pack, GitHub events, change-request implement, and five or six new MCP tools. The change request says five, but the wave plan adds a sixth (`get_handover_report`). The count needs one correction before the RTM rows are written.
- **Lean list payloads.** List routes return a summary by default. Callers that need every field pass `?view=full`, and callers that want named fields pass `?fields=`. This changes what existing callers receive and is owner-visible.
- **Audit immutability is strengthened, not weakened.** The hash chain makes edits detectable. Every mutation still writes exactly one audit row, now inside the same transaction as the change (W4-C).
- **Unchanged.** No LLM is bundled. Writes stay API-only. The workspace isolation rule and the scope model are unchanged. Resend stays in demo mode and no email is sent.
- **Ask before the next scope change.** Any further item beyond CR-2026-10-18-01 goes back to the maintainer first, per the scope rules in `CLAUDE.md`.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Narrow the positioning instead. Drop the governance-tier and agent-surface claims and sell only the reporting outcome. | The owner chose to build the full brief. The positioning depends on evidence that only the gaps provide. |
| Build only section M (the evidence and control items). | Section M alone leaves the unattended-operation promise (A-items) unmet and the change-request evidence chain incomplete. |
| Build all items in one wave. | Too large to review in one pass. Each wave needs its own UAT round before the next starts. |

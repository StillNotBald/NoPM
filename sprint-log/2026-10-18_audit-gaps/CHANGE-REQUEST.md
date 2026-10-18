# CR-2026-10-18-01 — Close the positioning-audit gaps

| Field | Value |
|---|---|
| Raised by | Owner (maintainer), 2026-10-18 09:40 MYT: "We need to build all" |
| Source | `_docs/directions-2026-10-17/NOPM_AUDIT_REPORT.md` (audit of 6fd8981 against the brief `NOPM_AUDIT.md`) |
| Category | Governance + Reporting + Agent surface + Integration |
| Status | APPROVED by owner (scope); assumptions below await an explicit yes/no but do not block the build |
| Decided by | Owner |
| Positioning served | "Your PMO runs without you, and leaves the evidence auditors ask for" |

## Scope

Every item rated PARTIAL, MISSING or STILL PRESENT in the audit: A1–A5, A7; B1–B3, B5–B7; G1–G5, G7, G8, plus the G6 caveats (NOT VALID checks, legacy null-principal rows); M1 (atomicity + tamper evidence), M2–M7; K1–K3, K5 (K4 preset). Built in four waves (see `PLAN.md`).

Outcome mapping (CLAUDE.md scope posture): M-items, G-items and K-items serve outcome 2 (easier reporting, audit evidence); A3, A5, B3, B5, B6, M6 serve outcome 1 (presentable multi-project); A7, B7, K4, K5 serve the agent surface; tier settings and stale thresholds serve outcome 3 (non-code configuration).

## Impact

| Area | Impact |
|---|---|
| Schema | migrations 0088–0105, all additive or widening; one column deprecation (risks.category stops being read or written; dropped in a later release) |
| API | new routes: handover report, audit pack, GitHub events, change-request implement; `fields`/`view` params on list routes; new MCP tools (6: list_change_requests, get_change_request, list_decisions, get_document, get_evm, get_handover_report) |
| UI | new pages: handover, change feed, approval policy settings; new buttons: export members/tokens, audit pack; evidence panel on change detail; backup-owner fields on forms |
| Security boundary | tier routing, timers and the emergency path change WHO can approve WHAT; all enforced in the route and in the database, never UI-only |
| Live data | backfills: `locked_by` from audit rows, `requested_principal_id` where derivable, `impact_areas[]` from `impact_area`; nothing destructive |

## Owner assumptions (built as stated; flag any you want changed)

| # | Assumption | Why |
|---|---|---|
| A1 | G3 auto-approve on timeout is built but OFF by default, allowed only on the `routine` tier, switchable per workspace by an admin in Settings. | Keeps the owner's "a second human decides money and dates" stance unless she opts out, and the brief requires the capability. |
| A2 | M2 reinstates `implemented` on change requests as an explicit "mark implemented" action (requester or approver, audited, `implemented_at >= decided_at` enforced by CHECK). This supersedes the earlier Q-GOV-2 answer "remove implemented". | The audit's go-live proof needs a timestamp after the decision. |
| A3 | Tier names follow the brief: routine, normal, high_risk, emergency, strategic. Default routing: routine → manager; normal → manager; high_risk → admin; emergency → any approver now + admin retro within 48 h; strategic → admin. Currency threshold default RM 50,000 bumps normal → high_risk. All editable in Settings. | The brief lists five tiers; defaults are placeholders she can change without code. |
| A4 | K1: `risks.category` is no longer accepted or returned; column kept until a later release drops it. | Zero data loss now; the payload bug is gone. |
| A5 | K4: the one-click agent preset gains `risk:write`, `issue:write`, `project:write` (never approve/decide scopes). | Owner-visible: tokens minted by the preset are broader. |
| A6 | A1 GitHub events only ever move tasks whose `external_ref` matches, never on a locked project, always as a connector actor with an audit row. | Keeps lock semantics and audit coverage. |
| A7 | Audit tamper evidence is a hash chain (`prev_hash`, `row_hash`) set by the insert trigger; no external anchor yet. | Additive, verifiable with one query; external anchoring is a later decision. |
| A8 | Deletion-by-request extends to expenses, approved documents, risks, issues, milestones (G8). Tasks and projects already have it. | The brief: "deletion requires a request, not a direct delete". |

## Owner decisions raised by wave 3

Wave 3 built a default for each of these. Each one needs an explicit yes or no from the owner. The builder's default stays in place until she decides.

| Decision | Builder's default (built) | What changes if she says no |
|---|---|---|
| D1. Nudge cadence | One reminder per stale item every 7 days, one batch audit row per run, at most 200 per run. | Daily reminders instead of one every 7 days. The daily ceiling is already in the schema, so the change is to the cooldown only. |
| D2. Weekly report catch-up | The report goes out only on the chosen weekday. A missed cron or a busy day loses that week unless an admin presses Send now. | Send late: the report goes out on any day after the chosen day, if the week has no report yet. |
| D3. Self-assignment of approvals | A request cannot be assigned to its own requester. The assignee must be an admin or manager. | Allow assigning a request to its own requester. Four-eyes still blocks that person from deciding. |
| D4. ETC on locked projects | The to-finish estimate and the forecast method change on a locked project with no change request. Both changes are audited. | Gate both fields behind an approved change request, by removing them from the exempt list. |
| D5. Dependencies on locked projects | Allowed and audited. A locked schedule does not change. | Refuse adding or removing a dependency on a locked project. |
| D6. Committed money | The system does not reduce committed when an invoice is entered. A visible hint tells the user (F5). | Build an automatic link from invoices to committed. That is new scope for this programme. |

## Owner-visible changes

Kept in `OWNER-VISIBLE.md` per wave and summarised in the PR.

## Post-UAT fixes

UAT findings are minted in `UAT-log/01-FINDINGS.md` only, root-caused in `02-ROOT-CAUSES.md`, retested in `03-RETEST-SHEET.md`. No pass/fail counts in `UAT-log/`; counts go to `testing-log/`.

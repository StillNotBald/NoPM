# ADR 0015 — Common-pattern defaults: when a question has a standard answer, take it

- **Status:** Accepted (owner decisions 19 to 25 and the rule "follow the common pattern", 2026-10-18)
- **Date:** 2026-10-18
- **Builds on:** ADR 0006 (atomic deletion), ADR 0012 (integration hub), ADR 0013 (principal-aware four-eyes), ADR 0014 (approver roles)
- **Resolves:** the open questions of the 2026-10-17 journey map (`journeys/OPEN-QUESTIONS.md`, `journeys/DECISIONS-2026-10-17.csv`)

## Context

The journey map and the 2026-10-17 audit left 75 questions for the owner, each of the form "what should happen when X". Most are not product-defining; mature tools (Jira, ClickUp, Asana, GitHub, Lark and others) already settle them the same way. Asking the owner to decide each one costs a day and adds nothing. A handful are different: they trade control against friction (money, access, deletion), and those need a person's choice.

## Decision

### The pattern rule

**Where a question has a standard answer across the tools people already use, the standard answer is the decision.** The proposals are recorded in `journeys/COMMON-PATTERN-ANSWERS.md` and `.csv`, each with its pattern source and a confidence. The owner answered "follow the common pattern" for all of them (rows with Owner choice = no), so they are decided as proposed. Rows that are already true in the code are only confirmed. Rows that depend on hour logging are withdrawn (decision 18). Decisions 7, 8, 9, 10, 11 and 16 stay in force.

The rule is also the default for future questions of this kind: propose the common pattern with its source and confidence, build it, and spend the owner's attention only on real trade-offs.

### The seven owner-choice decisions

| # | Question | Decision |
|---|---|---|
| 19 | Overspend (Q-WRK-7) | Warn, never block. The budget reports `overspend` with level `ok`, `warn` (default 90% of plan, settable 1 to 100) and `over` (100%). One `budget.overspend` audit row per level change. |
| 20 | Deleting a whole project (Q-GOV-12) | The approver sees counts (already live). Deletion is refused (422 `project_has_approved_records`) while the project has approved change requests or approved/applied rebaselines, at request time and again in the commit RPC (P0022). Stored files of deleted documents are removed after commit. |
| 21 | Token life (Q-ACC-4) | New tokens default to 90 days, maximum 365. The list shows `days_left` and `expiring_soon` (under 14 days). Existing tokens are untouched. |
| 22 | Two-step for admins and managers (Q-ACC-6) | Required, with a 14-day grace from release (current holders) or from promotion (new ones). After grace the console sends them to enrol. Tokens keep working; the demo is exempt. |
| 23 | Money records (Q-WRK-12/13) | A budget change on a locked project needs an approved change request (`change_request_id`). Expenses stay audit-only. |
| 24 | Defer (Q-GOV-1) | A deferred change request is parked: the requester or a manager/admin reopens it to `under_review` (audited). |
| 25 | Decisions and documents (Q-GOV-26, Q-GOV-14, Q-REV-18) | Stay tier B (one person records). Only a manager or admin marks a decision accepted or a document approved, and the document's author cannot approve it. No extra versioning now; tier A (versioned, never deleted) if a client asks for audit evidence. |

### Tiers

The decisions rest on one distinction the code now states plainly:

- **Tier A, a second person decides:** project and task deletion, change requests, rebaselines. Money and dates.
- **Tier B, one person records, a manager or admin confirms:** decisions and documents.
- **Audit-only:** everything else. The audit row is the control.

## Consequences

- New API surface: change-request review and reopen, rebaseline withdraw, invite renew, members (session only), workspace settings, connector delivery list and retry. All are in `openapi.json` and `llms.txt`. A deletion-request withdraw tool is added to the MCP server, the assistant and the CLI.
- Unknown body fields are refused 422 on the work-record endpoints ("Unknown field "x". Nothing was saved.") instead of being silently dropped.
- The leaver procedure becomes one admin action (`DELETE /api/members/{id}`) instead of an operator task.
- Migrations 0076 to 0081, 0083 and 0084 (there is no 0082) are additive; the rollout is `CUTOVER/10-COMMON-PATTERN-ANSWERS.md`.
- Still open: file versioning and the clean-up job for replaced files (Q-GOV-22), and the 14-day session length, which is a Supabase dashboard setting and an owner step (Q-ACC-20, Pro plan).
- Pattern sources marked "unverified" in the answer file were general product knowledge, not fetched documents; those rows carry a lower confidence and are the first to revisit if a client disagrees.

## Alternatives considered

- **Ask the owner each question.** Rejected: slow, and most answers were not in doubt.
- **Block overspend (decision 19 option C), expenses above a limit need a manager (23 option C), 30-day trash for projects (20 option C), hard 90-day token cap (21 option C).** Rejected: they add friction for small teams, and the lite posture (outcome-scoped) favours warn-and-audit.
- **Full compliance tier for decisions and documents now (25 option B).** Deferred until a client asks for audit evidence.

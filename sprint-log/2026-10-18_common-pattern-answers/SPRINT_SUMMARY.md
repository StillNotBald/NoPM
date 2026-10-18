# Sprint Summary — 2026-10-18_common-pattern-answers

**TL;DR:** The owner answered the journey map's open questions with one rule, "follow the common pattern", and decided the seven owner-choice items (19 to 25); the pattern answers and the seven decisions are built on branch `feat/common-pattern-answers` (migrations 0076 to 0081, 0083, 0084), documented, and not yet released.

## Declared goals
- Build the proposed answers in `journeys/COMMON-PATTERN-ANSWERS.md` where the owner choice is "no", and confirm the ones already true (R-IDs: R-120 to R-126)
- Build decisions 19 to 25 (overspend warning, project-deletion refusal, token life, required two-step with grace, budget change control, deferred reopen, tier-B decisions and documents) (R-IDs: R-120 to R-124)
- Document the new API surface (OpenAPI, `llms.txt`, MCP README), the use cases, the leaver runbook, the manual, an ADR and a rollout runbook (R-IDs: none new)

## Actual outcomes
- **Decisions** 19 to 25 are in [`DECISIONS.md`](DECISIONS.md), with "follow the common pattern" recorded as the rule for the rest. ADR 0015 summarises them.
- **Governance (migrations 0076, 0077):** change-request review and reopen, rebaseline withdraw, version-pinned decisions with required rationale, project-deletion refusal and file removal, lock no-op, orphan draft rebaselines cancelled.
- **Registers and money (0078, 0079):** overspend levels with one audit row per crossing, budget change on a locked project needs an approved change request, decision and document tier-B rules, supersede loop guard.
- **Work items (0080):** unknown fields refused, one live clash per person and type, sprint timing flag and close destination, milestone open-task confirm, risk and issue resolution, drag no longer voids a deletion request.
- **Auth and people (0081, 0083):** 90-day token default, required two-step with a 14-day grace, invite renew and restore, admin-created guard, members API (roles, removal, restore, two-step reset). The leaver runbook is now one action.
- **Integrations (0084):** rebaseline cards in Lark, assistant key checks, failed-delivery list and retry, workspace time zone.
- **Open questions:** `journeys/OPEN-QUESTIONS.md` and `journeys/DECISIONS-2026-10-17.csv` mark every answered question with its decision number or "decided 2026-10-18 (common pattern)". Still open: Q-GOV-22 and Q-ACC-20.
- Migration 0082 does not exist (the number is unused; the runner applies by filename).

**Docs changed in this sprint:** `openapi.json` and `llms.txt` (13 new operations, new error codes, the pattern rules), the MCP README, requirements R-120 to R-126 with their RTM rows, ADR 0015, use cases UC-02 to UC-06, UC-09 to UC-13, UC-17 to UC-19, UC-23, UC-26, the guide (governance, FAQ), the user manual, SECURITY, the roadmap, the user-provisioning runbook, and `CUTOVER/10-COMMON-PATTERN-ANSWERS.md`.

## R-IDs touched
- R-120 to R-126 → DONE (new)
- No other R-ID status changed.

## Files
- `docs/adr/0015-common-pattern-defaults.md`, `CUTOVER/10-COMMON-PATTERN-ANSWERS.md`, `requirements/REQUIREMENTS.md`, `requirements/TRACEABILITY.md`, `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts`, `journeys/OPEN-QUESTIONS.md`, `journeys/DECISIONS-2026-10-17.csv`
- Code and migrations: see the R-120 to R-126 rows in the RTM.

## Tests / verification
- `npx vitest run src/lib/api/openapi-coverage.test.ts src/lib/api/llms-coverage.test.ts src/lib/assistant/tools-openapi.test.ts` (every route documented in the spec and in `llms.txt`)
- `cd web && npm run rtm:verify`
- The full test run, typecheck and lint are the code workers' receipt for this branch.

## Follow-ups
- Release: follow `CUTOVER/10-COMMON-PATTERN-ANSWERS.md` (backup, dry run, apply `--atomic`, deploy, smoke). The two-step grace starts at release.
- Owner step: set the Supabase session length to 14 days (Pro plan).
- Decide Q-GOV-22 (replaced files, 30-day clean-up job, document versions).

# Sprint Summary — 2026-10-18_integration-review-fixes

**TL;DR:** The integration-layer fixes from the 2026-10-17 night review (F1, F2, F3, F5, F6, F7, F10) are built with tests on a branch; F4, F8, F9 and F11 are recorded as open design items in ADR 0012, and ADR 0015 (module registry, Level 1) is drafted as Proposed.

## Declared goals
- Repair a lost approval-card emit in the daily tick (F1) and add a "Requeue dead" admin action (F2) (R-IDs: R-120, R-98)
- Close the pre-auth oracle on the relay URL, make the link-code limiter fail closed, treat a missing app id as a mismatch (F3, F5, F6) (R-120)
- Make connector health honest (F7) and make a retired-kind card say so (F10) (R-120)
- Record F4, F8, F9, F11 as open design items; draft ADR 0015 (docs only)

## Actual outcomes
- `reconcileLostApprovals` runs per active connector in the cron tick: pending requests older than 5 minutes with no card in any state, 20 per connector per tick, audited as the scheduler.
- `POST /api/integrations/connectors/{id}/requeue-dead` (admin session only, audited before queueing) and a "Requeue failed cards" button shown while anything has failed.
- Relay route answers one generic 401 for every pre-auth failure; the reason is logged only. The worker's message now lists all three causes.
- Link-code limiter refuses the attempt when the rate RPC errors; the stale "fail-open" comments are corrected.
- A card or message event with no `header.app_id` is ignored as a different app.
- Health gains `cron_state_available` and `scheduler_stale` (over 36 hours); the last failure is ordered by latest attempt (`next_attempt_at`, since no last-attempt column exists).
- `unsupported_kind` maps to "This kind of request is no longer handled here. Open NoPM."; migration 0076 marks open `timesheet` action tokens used. Hour logging is already removed on main (a6a2716), so F10 applied.

## R-IDs touched
- R-120 → DONE (new)

## Files
- `web/src/lib/integrations/{catchup,cron,health,inbound,identity}.ts`, `lark/{handlers,http}.ts`
- `web/src/app/api/integrations/connectors/[id]/requeue-dead/route.ts`, `lark/[connectorId]/relay/route.ts`
- `web/src/components/integrations/{connected-panel.tsx,api.ts,model.ts}`
- `web/supabase/migrations/20261018000076_retire_timesheet_action_tokens.sql` (NOT applied)
- `docs/adr/0012-...md` (open design items), `docs/adr/0015-module-registry-level-1.md` (Proposed), `docs/guide/07-lark-integration.md`

## Tests / verification
- Full vitest suite, `tsc --noEmit`, eslint on touched files, `npm run rtm:verify`. See the PR for counts.
- One failing test in `marketing.test.ts` is a CRLF working-copy artefact (a regex that expects LF) and is unrelated to this change.

## Follow-ups
- Apply migration 0076 to the live project (owner step, not done here).
- Decide F4, F8, F9, F11 (ADR 0012, Open design items) and ADR 0015.
- Reconciliation skips a request that has any card, so a newly linked approver does not get a card for an older request; that is the resume path's job.

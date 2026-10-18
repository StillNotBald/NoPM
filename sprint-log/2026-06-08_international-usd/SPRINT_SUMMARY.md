# Sprint Summary — 2026-06-08_international-usd

**TL;DR:** Wave B final — task dependencies + CPM Gantt, sub-task checklists, board pack export, risk/issue detail drawers, and currency standardized to USD throughout.

## Declared goals
- Task dependencies with CPM critical-path computation and Gantt dependency arrows (R-12, R-33)
- Sub-task checklists (jsonb) + real member assignee picker (R-12)
- Board pack export: cover/RAG/EVM/risks/issues/milestones + per-project status report endpoint (R-40)
- Risk + issue detail drawers in right-push panel (R-13, R-14)
- Currency standardization: MYR → USD across API, budget, resources, forms (see ADR 0002)

## Actual outcomes
- `lib/schedule/cpm.ts`: critical path algorithm (float computation, critical flag)
- `components/tracking/gantt.tsx`: dependency arrows (red for critical path), data-flow gap fixed (deps wired from project page → tabs → GanttChart)
- Task checklist: jsonb `checklist` field, `sub_task_checklists` migration, member assignee picker
- `api/reports/project/[id]/route.ts`: per-project status report (board pack section)
- Board pack: cover / RAG / EVM / risks / issues / milestones; section toggles
- Clash enrichment: description, over-allocation %, recommended action
- Risk + issue detail drawers in `components/registers/risk-detail.tsx`, `issue-detail.tsx`
- Migration 0012 `schedule_depth.sql`, migration 0013 `currency_usd.sql`
- `populate-wave-b.mjs` demo-data script for Wave B showcase
- Reversed MYR → USD (see ADR 0002)

## R-IDs touched
- R-12 → DONE (dependencies + checklists + assignee picker)
- R-13 → DONE (risk detail drawer)
- R-14 → DONE (issue detail drawer)
- R-33 → DONE (CPM Gantt arrows)
- R-40 → DONE (per-project status report)

## Files
- `web/src/lib/schedule/cpm.ts`
- `web/src/components/tracking/gantt.tsx`
- `web/src/components/registers/risk-detail.tsx`, `issue-detail.tsx`
- `web/src/app/api/reports/project/[id]/route.ts`
- `web/supabase/migrations/20260608000012_schedule_depth.sql`
- `web/supabase/migrations/20260608000013_currency_usd.sql`
- `web/scripts/populate-wave-b.mjs`

## Tests / verification
- Manual: dependency arrows visible on Gantt; critical path highlighted; EVM numbers consistent with USD; board-pack export verified

## Follow-ups
- R-60 vitest governance-invariant suite (P0 blocker)
- R-62 live deploy verification
- ADR recorded: see `docs/adr/0002-currency-usd.md`

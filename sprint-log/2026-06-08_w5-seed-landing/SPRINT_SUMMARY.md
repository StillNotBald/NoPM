# Sprint Summary — 2026-06-08_w5-seed-landing

**TL;DR:** Demo seed (6 projects, 5 resources, over-allocation clash, pending approval) + employer-facing landing; prod build passes.

## Declared goals
- Seed script: demo workspace with all key demo scenarios visible (R-52)
- Public landing page: dual-wedge + agent-terminal hero + governance explainer (R-50)

## Actual outcomes
- `seed.mjs`: 6 projects (1 locked, 1 complete), 18 milestones, 72 tasks across Kanban states, 6 risks, 6 issues, 5 resources, over-allocation → resource clash, budgets with variance/burn, expenses, time entries, one pending deletion request
- Landing (`/`): agent-terminal hero, dual-wedge explainer (AI-operable vs governance-grade), try-demo CTA
- `next build` passes clean

## R-IDs touched
- R-50 → DONE
- R-52 → DONE

## Files
- `web/scripts/seed.mjs`
- `web/src/app/page.tsx`

## Tests / verification
- `npm run build` — clean pass
- Manual: seeded dashboard shows over-allocation clash + budget variance

## Follow-ups
- UI enrichment passes (Apple re-theme, PMBOK fields, EVM, reference IDs) follow in separate waves

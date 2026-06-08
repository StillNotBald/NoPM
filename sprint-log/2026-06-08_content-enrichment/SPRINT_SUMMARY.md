# Sprint Summary — 2026-06-08_content-enrichment

**TL;DR:** Four enrichment passes in one day: Apple re-theme → 3-panel shell → PMBOK fields → EVM + risk scoring + History tab; also right-push panel + reference IDs.

## Declared goals
- Re-theme to Apple/iOS white+grey (matching prior-console-app look-and-feel)
- 3-panel responsive shell: icon-rail sidebar, mobile drawer, right-push inspector
- PMBOK content enrichment: additive nullable fields on all entities (charter, risk scoring, baseline dates, task acceptance criteria, issue severity)
- EVM panel: PV/EV/AC/CPI/SPI/EAC/VAC from real budget + completion data
- Risk scoring + 5×5 heatmap; project History tab (immutable audit stream)
- Reference IDs R-/ISS-/CL- on registers

## Actual outcomes
- Tailwind token swap (cream/coral → white/grey, blue accent, SF type scale)
- `app-shell.tsx`: collapsible icon-rail, mobile drawer, `useInspector` right-push panel (pushes `<main>` lg:mr-[28rem])
- Migration 0008: PMBOK fields (charter, risk scoring/response/category, milestone baselines, task acceptance/estimate/blockers, issue severity/category, budget actuals/reserves) — all nullable
- `lib/evm.ts`: PV/EV/AC/CPI/SPI/EAC/VAC; budget page EVM panel; portfolio roll-up
- `registers/risk-heatmap.tsx`: 5×5 probability × impact heatmap
- `tracking/history-timeline.tsx`: terminal-style immutable audit stream
- `lib/ref-id.ts` + migration 0010 + backfill migration 0011: R-/ISS-/CL- reference IDs on clashes, risks, issues
- Command-centre dashboard: RAG donut, program bar, health-rollup KPIs, risk/issue counts per project row
- Re-seed: charters, multi-sentence narratives, 5-8 tasks/milestone
- Fixed: removed hardcoded demo password from scripts (env-based); MYR currency standardized (later reversed to USD in Wave B — see ADR 0002)

## R-IDs touched
- R-30 → DONE (command-centre dashboard enhanced)
- R-31 → DONE (right-push inspector panel)
- R-33 → DONE (Gantt with dependency arrows + CPM)
- R-35 → DONE (History tab = immutable audit stream)

## Files
- `web/src/lib/evm.ts`, `web/src/lib/ref-id.ts`, `web/src/lib/schedule/cpm.ts`
- `web/src/components/dashboard/rag-donut-card.tsx`, `health-rollup-cards.tsx`, `program-bar-card.tsx`
- `web/src/components/tracking/history-timeline.tsx`, `gantt.tsx`
- `web/src/components/registers/risk-heatmap.tsx`
- `web/src/components/layout/app-shell.tsx`
- `web/supabase/migrations/20260608000008_content_enrichment.sql`, `0009_fix_allocation_cap.sql`, `0010_reference_ids.sql`, `0011_backfill_reference_ids.sql`

## Tests / verification
- Visual manual pass; EVM numbers spot-checked vs budget rows

## Follow-ups
- USD standardization (ADR 0002) applied in Wave B final commit
- R-60 (vitest governance invariants) still TODO

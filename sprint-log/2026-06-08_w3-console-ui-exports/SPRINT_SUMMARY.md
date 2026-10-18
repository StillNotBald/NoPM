# Sprint Summary — 2026-06-08_w3-console-ui-exports

**TL;DR:** Full console UI across all 8 modules + server-side deck export PPTX/PDF/HTML; verified 3/3.

## Declared goals
- Console pages for all 8 PM modules + governance screens (R-30..R-36)
- Audited Kanban: dnd-kit drag = one audit row (R-32)
- Deck export: data-driven HTML/PPTX/PDF from /api/reports/deck (R-40)

## Actual outcomes
- Pages: login, RAG dashboard, projects + audited Kanban, risk/issue/clash registers, resources, budget, Trust Center, approvals queue, tokens + TOTP enrollment
- dnd-kit Kanban: each card drag emits one `audit_log` row
- Deck export routes verified: HTML ✓, PPTX ✓, PDF ✓
- Fixed: resources `role_title` column name, budget `planned_amount`/`committed_amount` column names, pptxgenjs TableCell API

## R-IDs touched
- R-30 → DONE
- R-31 → DONE
- R-32 → DONE
- R-34 → DONE
- R-35 → DONE
- R-36 → DONE
- R-40 → DONE

## Files
- `web/src/app/(console)/dashboard/page.tsx`, `projects/page.tsx`, `risks/page.tsx`, `issues/page.tsx`, `clashes/page.tsx`, `resources/page.tsx`, `budget/page.tsx`, `trust/page.tsx`, `approvals/page.tsx`, `tokens/page.tsx`
- `web/src/components/kanban/board.tsx`
- `web/src/app/api/reports/deck/route.ts`, `web/src/lib/reports/{gather,html,pptx,pdf,index}.ts`

## Tests / verification
- Manual smoke: deck export 3/3 (HTML/PPTX/PDF)

## Follow-ups
- Seed + employer-facing landing (W5) next sprint
- Gantt read-only shipped; rebaseline flow wired in W-B

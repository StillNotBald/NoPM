# Sprint — Deep-review remediation (2026-06-09)

**Intent:** close the gaps the deep review surfaced — wire the built-but-dark features, restore the credibility layer (RTM/tests/receipts/ADRs), and sweep UI consistency. Driven by a 7-agent AI-assisted wave + integration.

## Done
- **Credibility layer (P0):** RTM reconciled in `requirements/{REQUIREMENTS,TRACEABILITY}.md` (R-IDs → real DONE status + 97 Code paths); `rtm-verify.mjs` hardened to assert files exist on disk → `rtm:verify` green. 7 backfilled `sprint-log/` receipts. ADRs `0002-currency-usd`, `0003-audit-cascade`.
- **Tests (P0):** vitest wired (`npm test`); 34 governance-invariant unit tests (hashToken, generateToken, hasScope, requireScope token+user/viewer, four-eyes self-approval) — **34/34 green**.
- **Wired dark features (P1):** task-create now persists acceptance_criteria/estimate_hours/story_points/labels/checklist; `Blocked by` → `POST /api/tasks/[id]/dependencies` (real CPM deps); project detail SELECT widened to fetch the enrichment columns; native `window.confirm/alert` → styled `ModalProvider` confirms + inline errors.
- **UI consistency (P1):** report exporters (html/pptx/pdf) re-themed white/near-black/terminal-green; landing terminal + budget-form (→ right-push panel); **Export board pack** button on the dashboard.
- **Honesty (P1):** EVM SPI computed from baseline dates (no longer always 1.00); reference IDs (R-/ISS-/CL-) set in seed so they show on the international dataset.
- **Register polish:** project Risks/Issues tabs open the rich detail drawers + show reference_id.

## Verification
- `tsc --noEmit` clean · `vitest` 34/34 · `rtm:verify` 34 IDs / 97 paths · `next build` 33/33 · deployed READY to stillnotbald.com · re-seeded international USD + wave-b demo data.

## Next
- Wave 2: persona journeys (SME log→follow-up · PM raise→review→report · C-level glance) + notification bell.

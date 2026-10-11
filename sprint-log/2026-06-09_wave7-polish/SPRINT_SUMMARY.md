# Sprint — Wave 7: baselines + Charter + case-study one-pager (2026-06-09)

**Intent:** close the remaining board backlog — milestone/task **baselines + Gantt slip** (#16), a project **Charter** surface (#18), and the employer-facing **one-page case-study PDF** (R-51). 3-agent AI-assisted wave (baselines-data · project-detail-ui · case-study) + verify; migration/seed/landing-link wired by hand.

## Done
- **Baselines + slip** (#16) — migration `0018`: `milestones.baseline_target_date`, `tasks.baseline_start_date/baseline_due_date` (null = not baselined). **Captured on project lock** (snapshot current dates → baseline, once, where null — the approved plan) and re-set on **rebaseline apply**; both keep their existing `writeAudit`. The **Gantt** now renders faint baseline ghost bars (tasks) + baseline diamonds (milestones) with a **slip indicator** (e.g. `+3d`) when current is later than baseline; degrades silently when null. Seeded so slip is visible: **18 milestones + 114 tasks baselined, 21 tasks showing slip**.
- **Charter tab** (#18) — a new first tab on the project detail surfacing the **linked charter Document** (Wave 4's governed doc — not duplicated): reference_id, status, summary, body preview, deep-link to `/documents?doc={id}`, plus the project meta block (program, owner/sponsor, RAG, completion, dates, currency). Graceful empty state ("Create charter" → /documents) when no charter doc exists.
- **Case-study one-pager** (R-51) — public `/case-study` route (thesis, the AI-native+governance wedge, what was built, proof metrics) + a client **jsPDF one-pager** download (single A4: thesis, wedges, build summary, metrics, live URL). Added a **"Case study"** link to the landing nav for discoverability.

## Verification
- `tsc --noEmit` clean · `next build` clean (44 pages incl. `/case-study`) · migration `0018` applied to prod DB.
- Baseline seed required a **PostgREST schema-cache reload** (`notify pgrst, 'reload schema'`) after the DDL before the supabase-js writes saw the new columns — noted for future post-migration seeds.
- RTM green: **39 R-IDs / 151 paths** — R-51 → DONE; R-33 + R-10 code paths extended (baselines, charter).
- Deployed to stillnotbald.com.

## Open / deferred
- Rebaseline **diff screen** (side-by-side before/after) not built as a standalone view — variance is shown inline on the Gantt; the rebaseline record's before/after remains in `audit_log` for the trail. Standalone diff = future polish.
- Case-study proof metrics are hardcoded constants (fine for a portfolio snapshot).
- Still pending: owner demo LLM key + a live visual walk-through.

## Status
Board fully cleared. v1 MVP + polish complete across Waves 2-7 — all deployed, audited, tested (102/102), and traceable (39 R-IDs).

# Sprint Summary — 2026-06-09_wave11-rehearsal-fixes

**TL;DR:** Fixed the gaps the 3-persona rehearsal surfaced — a real "My tasks always empty" bug, the dashboard status-dossier panel (C-level journey), a richer Profile (avatar + email), and a personal-email privacy leak.

## Declared goals
- Fix all gaps from the persona rehearsal + add a profile setting (user: "lets fix all, also need a profile setting").

## Actual outcomes
- **My Work "Tasks assigned to me" was always empty — real bug, not data.** Root-caused by reproducing the SSR server-client path: `my-work/page.tsx` selected `tasks.reference_id`, but the `tasks` table has **no** `reference_id` column → the query errored (`column tasks.reference_id does not exist`) → `tasksResult.data` was null → empty list. (Risks/issues legitimately have `reference_id`; tasks don't.) Removed it from the select; My Work now shows the 18 open tasks. *Status-only smoke + an `id`-only debug query both passed — only the exact page query + a body-level render check exposed it.*
- **Dashboard project dossier (C-level §4a):** clicking a portfolio row now opens a right-push **status dossier** in the inspector — RAG + completion, milestone tracker, open risks/issues (deep-linked), recent **change history** (audit slice), baseline-slip, and "Open full project →". The project name still deep-links directly (stops propagation). New `ProjectDossier` + `DashboardProjectRow`; fetches via existing `/api/projects/[id]` + `/milestones` + `/risks` + `/issues` + `/api/audit`.
- **Profile setting:** Settings → Profile now shows an avatar (initials), the account **email** (read-only, from the browser Supabase client), display name (editable, audited via `PATCH /api/me`), role + workspace.
- **Privacy:** removed a hardcoded personal email from the Settings "Contact support" link → `hello@stillnotbald.com`.

## R-IDs touched
- R-41 / R-44 (My Work / unified identity) → bug fixed (tasks now resolve)
- R-30 (RAG dashboard) → enhanced with the status dossier panel
- R-46 (Account & identity menu + profile) → Profile enriched (avatar + email); privacy leak removed

## Files
- `web/src/app/(console)/my-work/page.tsx` (drop `tasks.reference_id`)
- `web/src/app/(console)/dashboard/page.tsx` + new `web/src/components/dashboard/{project-dossier,dashboard-project-row}.tsx`
- `web/src/app/(console)/settings/page.tsx` (avatar + email + leak fix)

## Tests / verification
- `tsc` 0 · `npm run build` 47 routes · dossier endpoints 200 (object + arrays) · My Work render confirmed (task names present, no error) via authed body check on the dev server.
- Post-deploy live rehearsal pending.

## Follow-ups
- Mainline switcher shell (parked, design-approved) — the next build.

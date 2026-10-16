# NoPM — 10-minute demo script (one page)

**Thesis line (say it first):** *"I build the systems that make unclear requirements impossible — governance lives in the data and API layer, not the UI."*
**Live at:** https://stillnotbald.com · Demo login: the **Try the live demo** button on the login page (a **manager** — it can decide others' work but never its own; that's the point).

## Pre-flight (T-60 min)
1. `cd web && node scripts/auth-smoke.mjs` — every page must be 200 (24 routes when the workspace has a project). This doubles as the Supabase keep-alive (free tier pauses on inactivity; this is the lesson-learned guard).
2. If seeded demo data looks stale/mangled: `node scripts/seed-sprints-timesheets.mjs` (purge-first, re-runnable).
3. Log in once as the demo identity and click through /dashboard — verify AS the funnel identity, never only as admin.

## The walkthrough (4 stories, ~2–3 min each)

**1. Governance you can't buy (the thesis)** — `/timesheets` → point at the **"Week approved — locked"** marker (approved timesheet = frozen history; the lock is a DB trigger, not UI) → `/review` → open the pending timesheet → decide it (works: you're a different person) → now submit your own week and try to approve it → **403, four-eyes banner**. Close with `/trust`: every click just taken is an immutable audit row; export the audit log — *the export itself appears in the audit log*.

**2. A messy portfolio made legible** — `/portfolio` (program rollup cards; declared vs computed RAG with a "Diverges" flag — accountability is explicit, not inferred) → `/mainline` and flip the 3 lenses (portfolio / project / dependency DAG with typed FS/SS/FF/SF edges + lag) → `/tasks` (cross-project register: filter, save the view, share/protect it, CSV export that matches the screen exactly).

**3. Delivery metrics from the audit trail** — `/sprints` → the active sprint: committed points are a **frozen snapshot** (edit a task's points later; the commitment doesn't move) → burndown with a real descending line → velocity across the two closed sprints → Flow card (cycle/lead time median + p85, exclusions stated). Punchline: *all of this is derived from the audit log — zero extra tracking columns.*

**4. The agent surface (no other PM tool has this)** — `/tokens#connect-agent` → three paths: scoped PAT (shown once), copy-paste MCP config, BYOK assistant → the punchline: **an AI actor can request a deletion, but the agent tool set and the assistant's scope ceiling carry no approve scope** — machine-checked in the test suite, not a policy doc. A different person still has to approve it. Mention `llms.txt` + `/api/openapi.json` as the machine-readable front door.

**If unattended:** the dashboard's **governance tour** card walks a visitor through stops 1–4 by itself.

## Do NOT do live
- **Don't accept an invite** (creates a real auth user on the shared instance) — demo create → show-once `npi_` link → revoke; the accept flow is a 30-second recording/screenshot.
- **Don't demo the first-run wizard live** (needs an empty workspace; the demo workspace is deliberately seeded) — screenshots.
- Don't delete seeded projects/tasks — deletion is maker-checker'd anyway, but the seed is the show.

## Likely questions, honest answers
- *"Is this multi-tenant?"* — workspace-isolation via RLS + explicit API filters, single workspace per profile by design; machine-checked (`workspace-isolation.test.ts`).
- *"What about email?"* — deliberately demo-mode (rendered previews, never sent); that's why invites are links.
- *"Can I self-host?"* — yes for the app: `docker-compose.yml` / `web/Dockerfile` or Vercel, plus `npm run setup` against your own Supabase project (`docs/SELF_HOSTING.md`). Replacing managed Supabase itself is documented, not shipped (deliberate scope decision, ADR 0010).
- *"How was it built?"* — multi-agent waves with adversarial verification; every wave has a receipt in `sprint-log/` and an RTM row — the repo itself is the governance demo.

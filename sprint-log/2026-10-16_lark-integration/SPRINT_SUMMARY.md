# Sprint Summary — 2026-10-16_lark-integration

> Written by the traceability worker from the tree and the round reports. The orchestrator filled in the gate numbers after running the gates; nothing below claims a gate result that was not observed.

**TL;DR:** Four-eyes now compares people instead of actor ids (and wildcard scopes can no longer grant an approve verb), governed tables are writable only through the audited API, and a Lark / Feishu integration lets an approver decide a governed request from a chat card — with a weekly digest, a "what is waiting for me" surface for agents and an ICS milestone feed. A second round then attacked it: three adversarial reviews found and closed lifecycle, tenancy, card-integrity and reliability gaps, and an impeccable UI audit with a five-way fix wave made the console accessible and its portfolio views correct. One migration (0048, the direct-write lockdown) was hotfixed to the live project on 2026-10-17; the rest are written and rehearsed locally but not applied, and the Lark adapter has never talked to a live tenant.

## Origin
- **2026-10-16 audit** (`docs/research/audit-2026-10-16/`, eight read-only reports). It confirmed the headline governance claim was bypassable: a person could raise a deletion request in the console and approve it with a PAT they minted themselves, because four-eyes compared actor ids (a profile id for a session, the `api_tokens` row id for a token — disjoint namespaces). The same defect covered change requests, timesheets and rebaselines; wildcard scopes (`task:*`, `*`) also granted the approve verbs.
- **Journeys were missing.** The catalogue is written for a console PM, but the 2026-09-06 thesis makes the approver the critical human — and the approver had no journey that starts outside the console: no chat-card decision, no "what is waiting for me" call for an agent, no weekly digest, no calendar feed.
- **Owner direction (2026-10-16):** build the integration for Lark first, use open source if possible, and permission was granted for the one new dependency (the official Lark SDK, MIT, pinned exactly at 1.74.0) and a daily Vercel Cron entry.
- **Round 2 (2026-10-17):** red-team R1 (governance bypass), R2 (the public Lark edge) and review R3 (hub reliability and the calendar feed), all against a LOCAL stack only, plus five UI auditors (shell, personal and portfolio, registers, governance and integrations, public pages) scoring the console against the Governed Terminal design contract.
- Plan, locked decisions D1–D10 and file ownership: `sprint-log/2026-10-16_lark-integration/PLAN.md`.

## Declared goals
- Make four-eyes compare the person, retroactively for every actor, fail-closed (D1) — R-95; wildcards never grant a privileged scope (D2) — R-96.
- One read-only "what is waiting for me" surface for REST, MCP and the CLI — R-97.
- An Integration Hub (fan-out plus exactly one identity-verified inbound decision) and a Lark / Feishu adapter, hosted and self-host — R-98, R-99; a console page to connect, link and subscribe — R-100.
- A milestone ICS feed any calendar app can subscribe to (D10) — R-101.
- Close the direct-write hole: the API is the only writer — R-102 (added as the wave widened).
- Fix the documentation drift the audit listed, add the decision records and use cases, and the small contract fixes (health build field, MCP 401 contract).
- **Round 2:** close every High and Medium the three reviews reproduced (R-103 … R-107) and every P0 and P1 the UI audit found plus the cheap P2s (R-108 … R-112), keeping the incumbent visual world and inventing no product claims.

## Actual outcomes
**Round 1 (2026-10-16)**
- **Principal-aware four-eyes (R-95).** `Actor.principalId` is the accountable human; every decision verb requires one (403 `no_principal`) and refuses the requester's own person (403 `self_approval`). Migration 0045 adds the principal columns, backfills them retroactively (token-raised rebaselines recovered from the audit log), adds principal-distinct CHECKs `NOT VALID`, and recreates both deletion-commit RPCs with the principal and an approval note while dropping the old overloads. All REST decision routes became thin wrappers over `lib/governance/decide.ts`, which the chat path calls too — one governed code path for the console, REST, CLI, MCP and Lark.
- **Wildcards (R-96).** The five approve / decide scopes are only ever granted by exact name, retroactively.
- **Pending-approvals surface (R-97).** `GET /api/review`, the MCP tool `list_pending_approvals` (registry now 25 tools) and `nopm review`, read-only, each item with `can_decide` / `reason_if_not` and `hidden_kinds`; there is deliberately no approve tool for an agent.
- **Integration Hub core (R-98).** Six deny-all tables (0046), identity linking by one-time `NPL-XXXX-XXXX` code (never by email), an inbound pipeline with idempotency, single-use recipient-bound action tokens and typed outcomes, an at-least-once delivery queue, a kill switch for both directions, a daily cron tick (retries + weekly digest) and the admin / member management routes. `audit_log` gained the server-derived `lark` channel and connector-provenance columns.
- **Lark / Feishu adapter (R-99, PARTIAL).** Card JSON 2.0 builders, SDK-backed send / patch, webhook authenticity, the `events`, `card` and `relay` routes, `web/scripts/lark-worker.mjs` for self-hosters with no public URL, and an owner / admin setup guide. Verified against the pinned SDK source, the official docs and in-memory doubles — not a live tenant.
- **Integrations console (R-100)**, **ICS feed (R-101)**, **RLS lockdown (R-102)** — see `requirements/REQUIREMENTS.md`. The documentation drift, ADR 0012 / 0013, UC-23 … UC-26 and the local-database probes landed in the same round.

**Round 2 (2026-10-17)**
- **Lifecycle guards (R-103, migration 0049).** A locked project's dates and baselines are frozen (route + trigger); a timesheet week is frozen from `submitted`, and an approval is bound to the entries that were submitted (digest + totals), so "submit 8h, add 40h, get 8h approved" fails; the sheet's own subject cannot decide it; makers with no recorded owner cannot raise a governed request; rebaselines follow an enforced state machine; a project deletion is refused if the project gained records after the request; decided change requests are immutable.
- **Tenancy and tool safety (R-104).** Every foreign id in a create or update body is checked against the caller's workspace (422 `invalid_reference`); `notify()` delivers only inside its own workspace; a decision that another supersedes can no longer be deleted into a 500; agent-tool ids must be UUIDs and each request must keep its own route's shape.
- **Platform hardening (R-105, 0050 + 0052).** `audit_log` is protected against TRUNCATE (privileges and a statement trigger); the rate limiter's window bug that doubled every cap is fixed and its counter table prunes itself; pre-auth limiters key on an address the caller cannot choose (`NOPM_TRUSTED_PROXY_HOPS` off Vercel); assistant tokens are marked by a `kind` column instead of a hideable name.
- **Hub reliability (R-106, 0051).** One delivery is one card and one token (idempotency key = delivery id); the pre-send request check; claim-time leases; an atomic, resumable weekly digest; a bounded cron (deadline, concurrency, oldest backlog first); retention; operator health in the admin view.
- **Card integrity (R-107, 0053).** A token carries the content version it was issued for, so a tap on a stale card is refused (`changed`) and the request re-issued; editing a pending change request re-issues cards; a per-approver hourly card budget; link-code throttling, approver-only tenant pin, announced link replacement; Encrypt Key required in webhook mode; a uniform pre-auth edge; a per-connector SDK token cache; masked audit ids and cleaned reject reasons.
- **Calendar feed (R-101 amended).** Windowed from 90 days back and paged past the database's silent 1,000-row ceiling (it used to drop every future milestone), strong ETag / 304, self-throttled, SEQUENCE bumps on a project rename.
- **UI wave (R-108 … R-112).** Shell and overlays (portaled out of the header, skip link, inert closed panels, labelled combobox palette, shared primitives, AA status inks, solid focus, `tailwind-merge`); portfolio correctness (Mainline edges and real Today, Today / Fit controls, donut arcs, open-only counts, honest Kanban saves, phone dashboard cards); registers (debounced URL search, labelled controls, required project picker, fitting columns, reachable inspector); governance legibility (the person-based four-eyes verdict in the console, the record beside the decision, one show-once panel, confirm on revoke, frozen-week messages, phone card lists); the public front door (CTA contrast, unfurl metadata and OG images, robots / sitemap, a working demo failure path, landmarks).

## Live hotfix — migration 0048 (2026-10-17)
- **Why it could not wait.** The red-team round showed that, on the live project's own policies from the first migrations, any signed-in member could write governed tables straight through the database REST endpoint — and `profiles` allowed a member to set their OWN `role` to `admin` (verified on a local stack), a self-promotion past every role check. The migration ledger table was also exposed (RLS off), so a fake "applied" row could make the runner skip a real migration.
- **What was done.** Migration 0048 alone was applied to the live project in one transaction, recorded in `_nopm_migrations`, with a before-and-after policy-and-grant check; it drops every non-select policy and revokes INSERT / UPDATE / DELETE from `anon` and `authenticated` on 24 tables (including `profiles` and `notifications`) and locks the ledger. The authenticated page smoke then passed **24 of 24**. Nothing else in this wave was applied by it; because the ledger skips by name, the normal runner will still apply 0045 → 0047 and 0049 → 0053 in order.
- **One thing the audit log cannot tell you.** A direct write through the database REST endpoint leaves no `audit_log` row, so past exploitation of the old policies cannot be ruled out from the audit trail. Recommended owner check: compare the live project's admin and manager list (`profiles.role`) with who is expected. **Done 2026-10-17:** a read-only live integrity check found three admins and managers, all expected: the workspace creator and two managers set by the seed scripts. It found no evidence of abuse in any check.

## Red-team and review results (round 2)
**What held** (verified against state, not just HTTP status)
- Self-approval through every identity of the requester — own session, own PAT, `*`, `task:*`, an ownerless token — was refused on all four request kinds; 12 of 12 hostile mint attempts (`*`, `task:delete:*`, case, whitespace, NUL, full-width variants) were refused; concurrent decisions (6 on one deletion, 3 on a change request, 3 on a timesheet) produced exactly one decision and one audit row.
- Cross-workspace access: 66 routes probed with another workspace's ids and 86 GETs with foreign filters returned 404 or nothing; connector, identity, digest and unlink routes held; no secret appeared in any table scan, response, audit row or the server log.
- The audit channel cannot be forged: `X-NoPM-Client: lark` (any case, in a list, or with provenance in the body) yielded channel `ui` / `api` and no connector provenance.
- Direct PostgREST writes as a member and as anon on every public table were blocked after 0048 (the baseline run recorded the holes open); only three `nopm_*` RPCs were callable by `authenticated` and none was harmful; storage bucket creation and GraphQL were closed.
- The Lark core trust chain: no unauthorised, double, forged-identity or replayed decision; header-case, timestamp-format, encrypted-versus-plaintext, oversize-body, prototype-pollution and duplicate-key attacks all failed closed; identity is only `operator.open_id` + tenant; tokens are single use, recipient-bound and take the target from their own row; refused clicks do not burn the token where that is the safe behaviour; cron auth rejected nine malformed headers; the loopback API override is ignored in production unless explicitly allowed.
- Hub design: the governed path never waits on Lark (raise 39 ms, approve 27 ms with every Lark call delayed 8 s); the retry ladder is exact; claims are exclusive across concurrent ticks; leases expire; digest data is workspace-scoped and minimal; unreadable secrets retry with zero tokens minted.

**What was found and fixed** (R-ID in brackets)
- R1: locked-project baseline rewritable by one `project:write` holder (H1), approve-then-diverge timesheets (H2), ownerless-token maker bypass (H3) [R-103]; timesheet subject approving their own hours (M1), non-terminal rebaselines (M2), project deletion cascading over records added after the request (M5), decided change requests editable (M6) [R-103]; cross-tenant references and notification injection (M3), agent-tool path escape through unencoded ids (M4) [R-104]; audit TRUNCATE, spoofable XFF rate keys, assistant-token hiding by name [R-105].
- R2: stale-card bait-and-switch (F1) [R-107]; SDK tenant-token cache shared by app id (F2) [R-107]; silent link displacement and unthrottled code guessing (F3) [R-107]; XFF-keyed pre-auth limiter (F4) and the doubled rate window (F5) [R-105]; foreign tenant pinning the connector (F6), audit-stream and oracle exposure (F7), approver DM flood (F8), optional Encrypt Key (F9), bidi characters in reject reasons (F10) [R-107].
- R3: calendar feed truncated at 1,000 rows and dropping the future, no ETag, unthrottled (F1, F10) [R-101]; duplicate cards (F2), serial unbounded cron (F3), lease from drain start (F4), mid-send decisions (F5), no pre-send state check (F6), non-atomic digest (F7), no retention and token churn (F8), no operator visibility (F9), fan-out capped at one page (F11), `npc_` not redacted in errors (F14) [R-106 / R-107].

**What stays open** — see the owner-decision list below; in short: governed unlock without a second person, session members holding approve verbs implicitly, pre-existing cross-tenant data, calendar feeds outliving their creator, manager-minted manager identities, document upload and storage paths (not exercised by the red team), one-tap change-request and timesheet cards, an event lost to a killed function, and a UTC-only digest weekday.

## UI audit (round 2)
- Five auditors scored the console 11, 12, 11, 12 and 13 out of 20 ("Acceptable — significant work needed"), with 3 P0 (the notification bell clipped off-screen below 1024px; the Mainline Network lens that could never render because its dependency query failed silently; the inspector not height-bound so Save was unreachable), 40 P1, and the rest P2 / P3. The detector was blind to every P0 and P1: they are runtime and cascade defects.
- The orchestrator's first pass (commit 8640176) moved every status text to the AA `-ink` tokens, layered the border-colour rule and made focus rings solid; five parallel fix workers then covered the five audited areas — shell and primitives, portfolio and tracking, registers and forms, governance and integrations, and the public pages. **Re-render after the wave:** 128 captures across both themes and both viewports.
  - **Closed:** 3 of 3 P0 and 36 of 40 P1.
  - **Re-score:** 15, 16, 15, 15 and 16 out of 20 (mean 15.4, up from 11.8).
  - **Clean:** no console error and no page overflow on any captured route, and axe is clean on every public page.
  - **Regressions:** two, both caused by `tailwind-merge` letting a caller's `mb-0` win. A callout border struck through the intro on /review and /approvals.
  - **Partials:** four (the slip label, phone Today, two register widths). Round 3 fixed them.
- One dependency was admitted by the fix-wave brief: `tailwind-merge`, pinned exactly at 3.7.0, so a caller's class override replaces a primitive's instead of losing to CSS order. It needs the maintainer's sign-off because the CLAUDE.md list asks before any new dependency.

## Round 3 (2026-10-17): code review, re-attack, one fix pass
**What ran.**
- Three read-only code reviewers: governance, API, MCP and CLI; the hub, calendar and notifications; the UI code.
- A re-attack of every round-2 finding against a rebuilt local app.
- A check of the Lark adapter against the official platform docs and the pinned SDK source.
- A live-order migration rehearsal: 0048 first, as on the live project, then 0045 – 0047 and 0049 – 0054 on fresh scratch databases.
- One fix pass.

The owner then cut the review rounds: no further review or re-verify waves, and only the automated gates after the fix pass.

**Found and fixed** (each with a test that fails on the old code)
- **Governance and core:**
  - The lock route locked BEFORE it snapshotted baselines, so the 0028 trigger refused the snapshot and every lock returned 500 with no baseline.
  - An approver could rewrite a pending change request, then approve it. Only the requester may now edit or delete an open request (403 `not_requester`).
  - The deletion scope missed `project_budget`, `clashes` and `calendar_feeds`, and its test was circular (migration 0054).
  - `api_tokens.last_used_at` was never written, because a lazy query builder was never sent.
  - Task and milestone PATCH blocked a no-op echo on a locked project.
  - Any member could submit, and so freeze, someone else's week.
  - A project could be created already locked.
  - A partial budget PATCH reset committed amount and currency, and dropped the reserve fields.
  - Malformed ids returned 500.
  - Cookie-authenticated mutations get an Origin check (403 `bad_origin`).
  - A task-deletion approval is refused when the task changed after the request (422 `target_changed`).
  - The requester's human may withdraw what their token raised.
  - A reopened timesheet can be resubmitted and re-approved.
- **Hub:**
  - An edit landing before the first card was sent left a live card showing old content with a token bound to the new version.
  - The cron sent the weekly digest one tick (a day) late.
  - Overlapping drains burned retry attempts ahead of the ladder.
  - A 200 with no message id counted as a send.
  - Patches to cards older than 14 days dead-lettered.
  - Deleting an open change request left live cards.
  - The calendar limiter keyed on a caller-written header.
  - A leaked link code could silently displace an existing link (now refused until the member unlinks).
  - `audit_log.external_actor_ref` held raw platform ids (now masked).
- **Lark docs check:** 67 of 80 claims matched the docs, 2 did not, and 11 need a live tenant.
  - The deletion card's `confirm` dialog never shows in Lark, so it was replaced by a notice on the card.
  - Direct messages are de-duplicated on `message_id`.
  - The URL handshake is answered before the rate check.
  - A log-only probe records which frame type a card click arrives as.
  - The owner setup checklist is `docs/runbooks/lark-first-live-test.md`.
- **UI:**
  - Opening the inspector for a second record reused the first record's form state, so it could PATCH B with A's values. It is now keyed per open.
  - The account menu and project switcher lost clicks in Safari and Firefox on macOS.
  - The phone filter sheet snapped back.
  - Delete confirms were at 3.9:1 contrast.
  - The slip label and the avatar failed AA.
  - Save is pinned in every form panel.
  - The /documents and /budget tables fit at 1280.
- **Rollout:** the safe order is migrate, then deploy, as one window (`CUTOVER/07-LARK-WAVE-ROLLOUT.md`, with SQL in `CUTOVER/sql/lark-wave/`).
  - The runner gained `--atomic` and `--dry-run` and now prints notices.
  - 0045 now fails closed on duplicate sign-offs instead of silently skipping its unique index.
  - 0054 removes the leftover write and PG17 `MAINTAIN` grants that API roles still held on nine deny-all tables.

**Left open by the scope cut:**
- `maxDuration` on the emitting routes.
- Calendar feeds outliving their creator.
- Cost and schedule impact shown on change-request cards.
- The uuid dedup window versus the retry ladder.
- The 503-versus-401 answer for a connector with unreadable secrets.
- Zero-width characters in reject reasons.
- Lark error hints, and the card-locked retry.
- Rebaseline sign-off atomicity, draft rebaselines with no promote path, and whether an applied rebaseline moves the project baseline.
- The stale debounced search after "Clear filters", and the remaining UI P2s.
- Atomic audit on non-RPC routes.

## R-IDs touched
- **New:** R-95 DONE · R-96 DONE · R-97 DONE · R-98 DONE · R-99 PARTIAL · R-100 DONE · R-101 DONE · R-102 DONE · R-103 DONE · R-104 DONE · R-105 DONE · R-106 DONE · R-107 DONE · R-108 DONE · R-109 DONE · R-110 DONE · R-111 DONE · R-112 DONE (DONE = code-complete; migrations 0045 – 0047 and 0049 – 0054 not yet applied to the live project, the F2a precedent; 0048 is live).
- **Amended inline (2026-10-16 and 2026-10-17):** R-02 · R-03 · R-04 · R-06 · R-07 · R-21 / R-22 · R-23 · R-24 · R-25 · R-37 · R-38 · R-62 (health build, cron entry, ledger lock) · R-64 (tool id safety) · R-67 · R-74 · R-82 · R-83 · R-84 · R-93, and R-95 … R-102 themselves for the round-2 changes (R-102 rewritten: 24 tables, the ledger lock, the live hotfix).
- `requirements/REQUIREMENTS.md` and `requirements/TRACEABILITY.md` were updated together; `npm run rtm:verify` from `web/` passed at drafting time (102 R-IDs status-matched, 1066 Code-file paths verified on disk); re-run at gate time: OK.

## Files
- **Migrations:** `web/supabase/migrations/20261016000045_principal_four_eyes.sql` · `…046_integration_hub.sql` · `…047_calendar_feeds.sql` · `…048_rls_api_only_writes.sql` · `20261017000049_lifecycle_guards.sql` · `…050_truncate_guard.sql` · `…051_hub_reliability.sql` · `…052_api_tokens_kind.sql` · `…053_hub_card_integrity.sql` · `…054_lifecycle_guards_2.sql`.
- **Governance:** `web/src/lib/governance/{decide,lock,period-lock,timesheet-decision,rebaseline-lifecycle,project-children,change-request-edit}.ts`, `web/src/lib/api/{workspace-refs,client-ip,rate-limit}.ts`, `web/src/lib/auth/{guard,tokens,scopes}.ts`, `web/src/lib/notify/publish.ts`, the deletion / change-request / timesheet / rebaseline / project / time-entry routes and the routes that now check foreign ids.
- **Agent surface:** `web/src/app/api/review/route.ts`, `web/src/lib/review/{pending,four-eyes,gather}.ts`, `web/mcp/tools.mjs`, `web/src/lib/assistant/*`, `cli/commands/review.mjs`, `web/src/app/api/health/*`, `web/src/app/api/mcp/route.ts`.
- **Integration Hub and Lark adapter:** `web/src/lib/integrations/*`, `web/src/lib/integrations/lark/*`, `web/src/app/api/integrations/**`, `web/scripts/lark-worker.mjs`, `web/vercel.json`, `web/package.json` (+ lockfile).
- **Calendar feed:** `web/src/lib/calendar/*`, `web/src/app/api/calendar/[token]/route.ts`, `web/src/app/api/calendar-feeds/**`.
- **Console and public UI:** `web/src/components/ui/*`, `web/src/components/layout/*`, `web/src/components/governance/*`, `web/src/components/registers/*`, `web/src/components/timeline/*`, `web/src/components/marketing/*`, `web/src/components/integrations/*`, `web/src/lib/timeline/*`, `web/src/lib/cn.ts`, `web/src/app/globals.css`, `web/src/app/(console)/**`, the public pages and OG image routes, `docs/product/DESIGN.md`.
- **Docs / receipts:** `docs/adr/0012-*`, `docs/adr/0013-*`, `docs/use-cases/UC-23 … UC-26`, `docs/guide/07-lark-integration.md`, `docs/research/audit-2026-10-16/`, `requirements/*`, this folder.
- **Probes and runner:** `web/scripts/local-db/*` (incl. `probe-rls-direct-write.mjs`), `web/scripts/apply-migrations.mjs` (ledger lock; `--atomic`, `--dry-run`, notices).
- **Rollout and live test:** `CUTOVER/07-LARK-WAVE-ROLLOUT.md`, `CUTOVER/sql/lark-wave/*.sql`, `docs/runbooks/lark-first-live-test.md`.

## Decisions (locked 2026-10-16 — see PLAN.md)
- **D1** Principal-aware four-eyes, retroactive for every actor; a null principal can never approve (and, since round 2, can never raise).
- **D2** Wildcards never grant privileged scopes; they must be granted by exact name.
- **D3** The four-eyes decision stays in NoPM; Lark only renders and relays a click (no Lark Approval mirror in v1).
- **D4** Open source first: the official Lark SDK, pinned exactly at 1.74.0; ICS, HMAC and AES hand-rolled on `node:crypto`; no other new dependency (round 2 added `tailwind-merge` 3.7.0 for the UI — pending sign-off, above).
- **D5** Two transports, one handler: hosted webhook routes, or a self-host worker over an outbound long connection that relays each event to the app over a signed POST.
- **D6** Scheduler is a daily Vercel Cron; immediate delivery uses `after()`.
- **D7** Identity linking by a one-time code minted by a signed-in member, never by email match.
- **D8** Fan-out, not an automations engine: fixed message types, fixed recipients; the only inbound mutation is a human, identity-verified, single-use approve / reject.
- **D9** Lark v1 moments: connect an app, link my account, approval card with Approve / Reject (reject needs a reason, one audit row with channel `lark`, cards update from any channel), weekly digest plus "send now", bot commands `help` / `link <code>` / `approvals`.
- **D10** ICS milestone feed, generic to any calendar app, revocable secret URL.

## Tests / verification
- `npx tsc --noEmit`: 0 errors
- `npm run lint`: 0 errors (5 pre-existing warnings)
- `npm run test` (vitest): 4835 passed / 4835, 186 files (round 2 closed at 4611 / 4611, 181 files)
- CLI tests (`cli/`): 49/49 · worker tests (`npm run test:worker`): 40/40
- `npm run rtm:verify`: OK at gate time (102 R-IDs status-matched, 1068 Code-file paths verified on disk)
- `npm run build` (local-stack env): OK · `npm run gen:metrics`: regenerated (102 R-IDs, 98 endpoints, 4835 tests, 17 deps) and `--check` passes
- Local Supabase (`npx supabase start`, seeded with the full demo chain): migrations 0001 – 0054 apply in order. Probes on a fresh production build: probe-migrations 9/9, probe-four-eyes 28/28, probe-rls-direct-write 23/23 (every direct member write blocked, reads intact), probe-api 15/15, probe-calendar 10/10, probe-lark 51/51 (real emit path against a loopback fake Lark; nothing reached a real Lark host)
- Live: 0048 applied 2026-10-17, authenticated page smoke 24 / 24 (reported by the orchestrator)
- Probes re-run after the round-3 fixes on a fresh production build: the same six pass (9/9, 28/28, 23/23, 15/15, 10/10, 51/51).
- **Live-order rehearsal:** the tracked runner on fresh scratch databases built to the live state (0001 – 0044 plus 0048, 45 ledger rows).
  - `--atomic --dry-run` applied the 9 pending files and rolled back, and `--atomic` committed them in one transaction in under 0.2 s.
  - The post-check had every row `ok`.
  - The catalog matches the fully ordered database: policies, grants, functions, constraints, triggers and RLS flags.
- **Re-attack of the R1 / R2 / R3 findings against the rebuilt app:** every High and Medium is closed except these:
  - one regression, the late digest, fixed in round 3;
  - member-session approvals, an owner decision;
  - three partials (link displacement, audit masking, a 503 oracle). The first two were fixed in round 3; the third is left open.
- **What held:** self-approval through a second token, wildcard approve, the `X-NoPM-Client: lark` spoof, card-click replay and direct PostgREST writes as member and anon.
- UI re-render and re-score after the round-2 wave: see the UI audit section above. Round 3 got one orchestrator spot check: 12 checks across both themes and both viewports, 0 flagged. The inspector-reuse fix is verified by code reading only, because the repo has no DOM test environment.
- Not run by anyone, on purpose: anything against the live Supabase project other than the 0048 hotfix, a dev server, or a live Lark / Feishu tenant.

## Follow-ups
**Open owner decisions**
- **Unlock and lock.** Any `project:write` holder can lock or unlock a project, and unlock needs no second person. Add four-eyes to unlock (and who may lock), or keep the admin / manager gate with a required reason (R-83)? **Decided in part 2026-10-17:** unlock stays single-actor, with the reason and audit row kept ([DECISIONS.md #7](../2026-10-17_post-live-followups/DECISIONS.md)). Who may lock is still open.
- **Who may approve.** A session user who is not a viewer still holds the approve verbs implicitly (a plain member approved and committed a deletion); tokens need an exact scope and Lark restricts chat decisions to admins and managers. Make session approval require admin / manager, or a workspace setting? **Decided 2026-10-17:** goes to the backlog ([DECISIONS.md #6](../2026-10-17_post-live-followups/DECISIONS.md)).
- **Existing data.** Repair cross-tenant references that already exist, and write the composite `(workspace_id, id)` foreign keys that would back the API check in the database? **Decided 2026-10-17:** the cross-tenant repair is closed; the live integrity check found 0 cross-workspace references, so nothing was removed ([DECISIONS.md #13](../2026-10-17_post-live-followups/DECISIONS.md)). The composite foreign keys are still open.
- **Ownerless legacy tokens.** New makers with no owner are refused and such a token can never decide, but requests they already raised stay approvable by any human principal (so they are not stranded). Revoke or assign owners to ownerless tokens, and whether to require an admin break-glass for those requests? **Closed 2026-10-17:** the live pre-check found 0 ownerless tokens (E1) and 0 requests raised by one (F4).
- **Dependency sign-off:** `tailwind-merge` 3.7.0 (above). **Decided 2026-10-17:** approved ([DECISIONS.md #12](../2026-10-17_post-live-followups/DECISIONS.md)).
- **Public copy** (UI audit A5): name MCP and the BYOK assistant on the landing; how and whether to mention Lark chat approvals and the calendar feed; keep, update or drop "shipped solo in eight waves"; confirm the demo account line on `/login` is the demo identity; relabel "Raise a change request"; show a real console screenshot (the audit's pick is the Trust Center stream). **Decided 2026-10-17:** the landing copy stays as it is ([DECISIONS.md #14](../2026-10-17_post-live-followups/DECISIONS.md)).
- **Caching:** `Cache-Control` on the public pages needs route-group layouts and a hash-based CSP; decide whether it is worth it. **Decided 2026-10-17:** approved ([DECISIONS.md #15](../2026-10-17_post-live-followups/DECISIONS.md)). In progress this sprint.
- **NOTICE:** the font section says no font files are committed, but two OFL font subsets now ship for the OG images with their licences beside them — list them in `NOTICE`. **Still open:** no 2026-10-17 decision covers this.
- Smaller:
  - Whether a manager may invite another manager, which creates a second human identity that satisfies four-eyes. **Decided 2026-10-17:** managers may invite managers ([DECISIONS.md #8](../2026-10-17_post-live-followups/DECISIONS.md)).
  - Whether a calendar feed should die with its creator's access. **Decided 2026-10-17:** it keeps working after the creator leaves; an admin revokes it manually if needed ([DECISIONS.md #9](../2026-10-17_post-live-followups/DECISIONS.md)).
  - Whether an applied rebaseline should move the project-level baseline; today no field carries proposed project dates. **Decided 2026-10-17:** yes, with an audit trail ([DECISIONS.md #10](../2026-10-17_post-live-followups/DECISIONS.md)). In progress this sprint.
  - Confirm the round-3 rule that only the requester edits an open change request. The alternative is to record the last editor and refuse their approval. **Confirmed 2026-10-17** ([DECISIONS.md #11](../2026-10-17_post-live-followups/DECISIONS.md)).
- **Live integrity check:** a read-only script looks for traces of direct writes made before the 0048 hotfix (it is kept out of the repo because its report lists admin emails). Running it against the live project needs the owner's go-ahead. **Run 2026-10-17;** its result is recorded under [DECISIONS.md #13](../2026-10-17_post-live-followups/DECISIONS.md).

**Before going live**
- Done 2026-10-17, see `CUTOVER/07-LARK-WAVE-ROLLOUT.md` "Run record".
- Follow `CUTOVER/07-LARK-WAVE-ROLLOUT.md`:
  1. Run the read-only pre-check.
  2. Build without aliasing.
  3. Apply 0045 – 0047 and 0049 – 0054 in ONE transaction (`--atomic`, after a `--dry-run`).
  4. Run the post-check.
  5. Promote.
  6. Run the post-window backfill.

  Never deploy first: the new build fails every governed decision on the old schema. 0048 is already live and is skipped by name.
- Set `CRON_SECRET` and the public app URL in the host environment; set `NOPM_TRUSTED_PROXY_HOPS` when self-hosting behind a reverse proxy (otherwise the pre-auth limiters share one bucket); mint approver tokens that need to decide with the exact scope (a legacy token that relied on a wildcard to approve now gets 403 until re-minted); give `functions.maxDuration` to the routes that emit if the host is not on a long-running plan (the hub's `after()` work is bounded by the platform default).
- A live-tenant test of the Lark adapter (R-99 stays PARTIAL until then), including card callbacks over the long connection, which are unverified.
- ~~Check the live project's `profiles.role` against who is expected~~: done 2026-10-17 (see the hotfix note).

**Known gaps and deferred**
- Sign in with Lark (SSO) — deferred; needs the OAuth / SSO decision from the maintainer.
- Link unfurl (rich previews of NoPM links in Lark) — deferred.
- Lark Calendar API write — deferred; the ICS feed (R-101) is the v1 calendar path.
- Lark Approval mirror — deferred to phase 2 (D3); the decision stays in NoPM.
- Generic signed outbound webhooks and an audit-table outbox — deferred to a later wave (ADR 0012); v1 fans out only the fixed approval and digest messages.
- Atomic audit for non-RPC routes — a route that writes a domain row and its audit row still does it in two statements (fail-closed, not atomic); only the RPC-backed paths are single-transaction.
- Unlock without a second person (above).
- A stakeholder role — deferred; not designed in this wave.
- Rebaseline sign-off is not available from a chat card (multi-approver, not in v1); chat decides deletions, change requests and timesheets, and a change-request or timesheet card approves with one tap and no confirm step.
- The Lark hub: nothing reconciles an event lost to a function killed before its inserts (safe — tokens stay dead — but the approver never gets the card); the digest weekday is UTC with no workspace timezone; the direct-message dedupe is in-process per instance.
- The red team did not exercise document upload and storage path handling; it needs its own review.
- Remaining audit items outside this wave (CI dependency drift, per-actor rate-limit buckets) stay on the audit report.

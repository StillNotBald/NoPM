# Sprint Summary — 2026-10-16_lark-integration

> **DRAFT** — written by the traceability worker from the tree. Gate numbers are `TODO` until the orchestrator runs the gates; nothing below claims a gate result that was not observed.

**TL;DR:** Four-eyes now compares people instead of actor ids (and wildcard scopes can no longer grant an approve verb), governed tables are writable only through the audited API, and a Lark / Feishu integration lets an approver decide a governed request from a chat card — with a weekly digest to a group chat, a "what is waiting for me" surface for agents, and an ICS milestone feed. Migrations 0045–0048 are written but not applied to the live project, and the Lark adapter has never talked to a live tenant.

## Origin
- **2026-10-16 audit** (`docs/research/audit-2026-10-16/`, eight read-only reports). It confirmed the headline governance claim was bypassable: a person could raise a deletion request in the console and approve it with a PAT they minted themselves, because four-eyes compared actor ids (a profile id for a session, the `api_tokens` row id for a token — disjoint namespaces). The same defect covered change requests, timesheets and rebaselines; wildcard scopes (`task:*`, `*`) also granted the approve verbs.
- **Journeys were missing.** The catalogue is written for a console PM, but the 2026-09-06 thesis makes the approver the critical human — and the approver had no journey that starts outside the console: no chat-card decision, no "what is waiting for me" call for an agent, no weekly digest, no calendar feed.
- **Owner direction (2026-10-16):** build the integration for Lark first, use open source if possible, and permission was granted for the one new dependency (the official Lark SDK, MIT, pinned exactly at 1.74.0) and a daily Vercel Cron entry. Nothing else on the CLAUDE.md "ask first" list was opened.
- Plan, locked decisions D1–D10 and file ownership: `sprint-log/2026-10-16_lark-integration/PLAN.md`.

## Declared goals
- Make four-eyes compare the person, retroactively for every actor, fail-closed (D1) — R-95.
- Wildcards never grant a privileged scope (D2) — R-96.
- One read-only "what is waiting for me" surface for REST, MCP and the CLI — R-97.
- An Integration Hub (fan-out plus exactly one identity-verified inbound decision) and a Lark / Feishu adapter, hosted and self-host — R-98, R-99.
- A console page to connect, link and subscribe — R-100.
- A milestone ICS feed any calendar app can subscribe to (D10) — R-101.
- Close the direct-write hole: the API is the only writer of governed data — R-102 (added as the wave widened; not in the original plan table).
- Fix the documentation drift the audit listed (UC-08, UC-10, UC-12, UC-17, UC-22), and add the decision records and use cases for the new surface.
- Small contract fixes the audit found: the health build field and the MCP 401 contract (amended into R-62 and R-25).

## Actual outcomes
- **Principal-aware four-eyes (R-95).** `Actor.principalId` is the accountable human (session → own profile id; PAT → `api_tokens.created_by`; assistant token → the signed-in person; Lark click → the linked profile). Every decision verb (deletion approve/reject, change-request approve/reject/defer, timesheet approve/reject/reopen, rebaseline sign-off and apply) now requires a principal (403 `no_principal`) and refuses the requester's own person (403 `self_approval`). Migration 0045 adds the principal columns, backfills them retroactively (token-raised rebaselines recovered from the audit log), adds principal-distinct CHECKs `NOT VALID`, and recreates both deletion-commit RPCs with the principal and an approval note while dropping the old overloads. All REST decision routes became thin wrappers over `lib/governance/decide.ts`, which the chat path calls too — one governed code path for the console, REST, CLI, MCP and Lark.
- **Wildcards (R-96).** `PRIVILEGED_SCOPES` (`task:delete:approve`, `project:delete:approve`, `time:approve`, `change:decide`, `rebaseline:approve`) are only ever granted by exact name; `*` and `<resource>:*` stop at that boundary, retroactively.
- **Pending-approvals surface (R-97).** `GET /api/review`, the MCP tool `list_pending_approvals` (registry now 25 tools) and `nopm review`, read-only, each item with `can_decide` / `reason_if_not` and `hidden_kinds` for scope-limited tokens. There is deliberately no approve tool for an agent.
- **Integration Hub core (R-98).** Six deny-all tables (migration 0046), identity linking by one-time `NPL-XXXX-XXXX` code (never by email), an inbound pipeline with idempotency, single-use recipient-bound action tokens and typed failure outcomes, an at-least-once delivery queue with a claim lease and retries (1 min … 12 h, then dead), a kill switch that stops both directions, a daily cron tick (retries + weekly digest) and the admin / member management routes. `audit_log` gained the server-derived `lark` channel and three connector-provenance columns.
- **Lark / Feishu adapter (R-99, PARTIAL).** Card JSON 2.0 builders (snapshot-tested), SDK-backed send / patch, webhook authenticity (signature, AES decryption, verification token), the `events` and `card` webhook routes, the `relay` route and `web/scripts/lark-worker.mjs` for self-hosters with no public URL (outbound long connection, HMAC-signed relay), and an owner / admin setup guide. Verified against the pinned SDK source, the official docs and in-memory doubles — not a live tenant.
- **Integrations console (R-100).** `/integrations`: connect / test / digest-now / pause / revoke for admins, a redacted status line for members, "Your Lark account" link-code card, calendar-feed card, and a collapsed "how approvals from chat stay governed" note; sidebar entry under Governance.
- **ICS feed (R-101).** Revocable secret-URL feeds (`npc_` token, hash only stored), deterministic RFC 5545 output, one identical 404 for unknown / malformed / revoked, owner-or-admin revoke, audited create and revoke.
- **RLS lockdown (R-102).** Migration 0048 drops every non-select policy and revokes INSERT / UPDATE / DELETE from `anon` and `authenticated` on 22 governed tables, so a signed-in member can no longer write them through the database REST endpoint; the service role, routes, RPCs and triggers are unaffected.
- **Contract fixes.** Deletion approve records its `{ note }`; change-request creation accepts only the raise-time statuses (a clean 422 instead of a raw constraint error); the Review Queue lists `raised` change requests; a token's rebaseline sign-off votes as its owner (403, not a foreign-key 500); `GET /api/health` reports `build: { sha, ref }`; the MCP endpoint's 401 uses the REST `{ error, code }` envelope with `WWW-Authenticate` and `X-Request-Id`; an earlier note in R-67 that the shared task scope gated project approval was corrected (the per-type gate was already wired).
- **Decision records and docs.** ADR 0012 (Integration Hub fan-out boundary), ADR 0013 (principal-aware four-eyes), UC-23 … UC-26, `docs/guide/07-lark-integration.md`, and drift corrections to the existing use cases and guides.
- **Local-database probes.** `web/scripts/local-db/` — scripts the orchestrator runs against a LOCAL Supabase stack only (guarded to refuse any non-loopback target) to prove the migrations apply in order, the four-eyes rules hold in the database, and a fake signed Lark callback commits an approval.

## R-IDs touched
- **New:** R-95 DONE · R-96 DONE · R-97 DONE · R-98 DONE · R-99 PARTIAL · R-100 DONE · R-101 DONE · R-102 DONE (DONE = code-complete, migrations not yet applied to the live project — the F2a precedent).
- **Amended inline (2026-10-16):** R-02 (principal on a verified token, wildcard rule) · R-03 (principal-aware, approve note) · R-04 (sign-off by person, apply needs an owner) · R-06 (writes are API-only, see R-102) · R-07 (principal CHECK, compare-and-set, raise-time statuses, `raised` in the Review Queue) · R-21 / R-22 (drift tests hold the new routes) · R-23 (`nopm review`) · R-24 (assistant token owner) · R-25 (`list_pending_approvals`, 401 contract) · R-37 (notices go to the requester's person) · R-38 (`raised` requests) · R-62 (health build, cron entry) · R-67 (principal-aware RPC; scope-gate note corrected) · R-74 (timesheet principal, wildcard, compare-and-set) · R-82 (`lark` channel, provenance columns) · R-83 (principal-distinct CHECK, privileged scopes) · R-84 (RPCs recreated, MCP 401 id) · R-93 (UC-23 … UC-26).
- `requirements/REQUIREMENTS.md` and `requirements/TRACEABILITY.md` were updated together; `npm run rtm:verify` from `web/` passed at drafting time (TODO: re-run after the last doc edits land).

## Files
- **Migrations:** `web/supabase/migrations/20261016000045_principal_four_eyes.sql` · `…046_integration_hub.sql` · `…047_calendar_feeds.sql` · `…048_rls_api_only_writes.sql`.
- **Governance:** `web/src/lib/governance/decide.ts`, `web/src/lib/auth/{guard,tokens,scopes}.ts`, `web/src/lib/assistant/token.ts`, the deletion / change-request / timesheet / rebaseline routes, `web/src/app/api/change-requests/_schema.ts`, `web/scripts/{bootstrap,seed-*}.mjs`.
- **Agent surface:** `web/src/app/api/review/route.ts`, `web/src/lib/review/pending.ts`, `web/mcp/tools.mjs`, `cli/commands/review.mjs`, `web/src/app/api/health/{route,_build}.ts`, `web/src/app/api/mcp/route.ts`.
- **Integration Hub:** `web/src/lib/integrations/*`, `web/src/app/api/integrations/{connectors,identities,cron}/**`, `web/vercel.json`, `web/src/lib/audit/{write,channel}.ts`.
- **Lark adapter:** `web/src/lib/integrations/lark/*`, `web/src/app/api/integrations/lark/[connectorId]/{events,card,relay}/route.ts`, `web/scripts/lark-worker.mjs`, `web/package.json` (+ lockfile; SDK pinned at 1.74.0).
- **Console:** `web/src/app/(console)/integrations/*`, `web/src/components/integrations/*`, `web/src/lib/nav/nav-config.ts`.
- **ICS feed:** `web/src/lib/calendar/*`, `web/src/app/api/calendar/[token]/route.ts`, `web/src/app/api/calendar-feeds/**`.
- **Docs / receipts:** `docs/adr/0012-*`, `docs/adr/0013-*`, `docs/use-cases/UC-23 … UC-26`, `docs/guide/07-lark-integration.md`, `docs/research/audit-2026-10-16/`, `requirements/*`, this folder.
- **Probes:** `web/scripts/local-db/*`.

## Decisions (locked 2026-10-16 — see PLAN.md)
- **D1** Principal-aware four-eyes, retroactive for every actor; a null principal can never approve.
- **D2** Wildcards never grant privileged scopes; they must be granted by exact name.
- **D3** The four-eyes decision stays in NoPM; Lark only renders and relays a click (no Lark Approval mirror in v1).
- **D4** Open source first: the official Lark SDK, pinned exactly at 1.74.0; ICS, HMAC and AES hand-rolled on `node:crypto`; no other new dependency.
- **D5** Two transports, one handler: hosted webhook routes, or a self-host worker over an outbound long connection that relays each event to the app over a signed POST.
- **D6** Scheduler is a daily Vercel Cron; immediate delivery uses `after()`.
- **D7** Identity linking by a one-time code minted by a signed-in member, never by email match.
- **D8** Fan-out, not an automations engine: fixed message types, fixed recipients; the only inbound mutation is a human, identity-verified, single-use approve / reject.
- **D9** Lark v1 moments: connect an app, link my account, approval card with Approve / Reject (reject needs a reason, one audit row with channel `lark`, cards update from any channel), weekly digest plus "send now", bot commands `help` / `link <code>` / `approvals`.
- **D10** ICS milestone feed, generic to any calendar app, revocable secret URL.

## Tests / verification
- `npx tsc --noEmit`: TODO
- `npm run lint`: TODO
- `npm run test` (vitest): TODO — count and files
- CLI tests (`cli/`): TODO · worker tests (`npm run test:worker`): TODO
- `npm run rtm:verify`: OK at drafting time (92 R-IDs status-matched, 870 Code-file paths verified on disk); TODO re-run at gate time
- `npm run build` (dummy env): TODO
- Local Supabase (`npx supabase start`): migrations 0045–0048 apply in order; RPC four-eyes probe; fake signed Lark callback probe; calendar probe: TODO
- Adversarial review agents: TODO
- Not run by anyone, on purpose: anything against the live Supabase project, a dev server, or a live Lark / Feishu tenant.

## Follow-ups
**Before going live**
- Apply migrations 0045 → 0046 back to back (the deletion RPCs recreated in 0045 write the `audit_log` columns that 0046 adds; no deletion approval may run between them), then 0047 and 0048; reload the PostgREST schema cache; live-verify.
- Set `CRON_SECRET` and the public app URL in the host environment; mint approver tokens that need to decide with the exact scope (a legacy token that relied on a wildcard to approve now gets 403 until re-minted).
- A live-tenant test of the Lark adapter (R-99 stays PARTIAL until then), including card callbacks over the long connection, which are unverified.

**Known gaps and deferred**
- Sign in with Lark (SSO) — deferred; needs the OAuth / SSO decision from the maintainer.
- Link unfurl (rich previews of NoPM links in Lark) — deferred.
- Lark Calendar API write — deferred; the ICS feed (R-101) is the v1 calendar path.
- Lark Approval mirror — deferred to phase 2 (D3); the decision stays in NoPM.
- Generic signed outbound webhooks and an audit-table outbox — deferred to a later wave (ADR 0012); v1 fans out only the fixed approval and digest messages.
- Atomic audit for non-RPC routes — a route that writes a domain row and its audit row still does it in two statements (fail-closed, not atomic); only the RPC-backed paths are single-transaction.
- Governed unlock has no four-eyes — any admin or manager can still unlock alone, with a required reason (R-83).
- A stakeholder role — deferred; not designed in this wave.
- Rebaseline sign-off is not available from a chat card (multi-approver, not in v1); chat decides deletions, change requests and timesheets.
- Remaining audit items not in this wave's scope (CI dependency drift, audit-table TRUNCATE guard, per-actor rate-limit buckets) stay on the audit report.

# PLAN — 2026-10-16 governance gap fixes + Lark integration (v1) + ICS feed

Owner-approved 2026-10-16 ("build the integration for lark first, I have granted you permission",
"use open source if possible"). Source research: `docs/research/audit-2026-10-16/00-SUMMARY.md`,
`04-integration-seams-architecture.md`, `05-lark-feishu.md`. Branch `feat/lark-integration`
(stacked on PR #7 `feat/uiux-overhaul`), built in a sibling git worktree `../NoPM-lark`.

## Owner decisions locked for this wave
- D1 **Principal-aware four-eyes, retroactive for every actor.** Four-eyes compares the HUMAN
  (`Actor.principalId`), not the actor id. Session → own id. PAT → `api_tokens.created_by`.
  Connector click → verified linked profile. Null principal can NEVER approve (fail-closed).
- D2 **Wildcards never grant privileged scopes.** `*` and `resource:*` exclude
  `task:delete:approve`, `project:delete:approve`, `time:approve`, `change:decide`,
  `rebaseline:approve`; those must be granted by exact name.
- D3 **Four-eyes decision stays in NoPM; Lark only renders + relays a click.** No Lark Approval
  mirroring in v1 (phase 2).
- D4 **Open source first:** official `@larksuiteoapi/node-sdk` (MIT) pinned EXACTLY at `1.74.0`
  (released 2026-09-14; newer builds are < 2 weeks old). No other new dependency. ICS, HMAC,
  AES are hand-rolled on `node:crypto`.
- D5 **Two transports, one handler.** Hosted (Vercel): Lark webhook routes. Self-host:
  `web/scripts/lark-worker.mjs` long-connection (SDK `WSClient`) that RELAYS each event to the
  app over an HMAC-signed local POST. Same handler code either way.
- D6 **Scheduler = Vercel Cron, daily** (`/api/integrations/cron`, `Authorization: Bearer
  $CRON_SECRET`): retries pending deliveries + sends the weekly digest on its configured weekday.
  Immediate delivery uses `after()` from `next/server`.
- D7 **Identity linking by one-time code**, never by email match: a signed-in NoPM user mints a
  code (`NPL-XXXX-XXXX`, 10 min, single use, hashed), DMs `link <code>` to the bot; the bot event
  carries the verified `open_id` + `tenant_key`.
- D8 **Fan-out, not an automations engine.** Hub sends fixed message types to fixed recipients;
  the ONLY inbound mutation is a human, identity-verified, single-use approve/reject on an existing
  governed request. No conditions, no chaining, no user templates.
- D9 Lark v1 moments: (1) connect a Lark/Feishu app, (2) link my account, (3) approval card DM to
  each eligible linked approver with Approve / Reject (reject needs a reason) → one audit row with
  `channel='lark'`; cards update in place when decided from ANY channel, (4) weekly digest to a
  group chat + "send now", (5) bot DM commands `help`, `link <code>`, `approvals`.
  Deferred: Sign in with Lark (SSO), link unfurl, Lark Calendar API write, Lark Approval mirror.
- D10 ICS calendar feed (generic: Apple / Outlook / Google / Lark calendars can subscribe):
  milestones as all-day events, revocable secret URL.

## Hard rules for every worker
1. `web/.env.local` does NOT exist in this worktree on purpose. NEVER copy it in, never run
   migrations, seeds, `verify-journey.mjs`, `auth-smoke.mjs` or anything against the live
   Supabase project. No dev server. No git commit / push / stash — the orchestrator commits.
2. Only edit files you OWN (table below). If you need a change in a file you don't own, put it in
   your final report under "Requests for orchestrator".
3. Other workers are editing the same tree at the same time. `npx tsc --noEmit` may show errors
   in files you don't own — ignore those, fix only yours. Run targeted tests:
   `npx vitest run <your test files>` from `web/`. Never pipe test output through head/tail;
   redirect to a file under `%TEMP%` and read it.
4. Every mutation = exactly one `audit_log` row via `writeAudit` (or inside an RPC). Every query on
   the admin client filters `workspace_id`. JSON contract `{data}` / `{error}` via
   `@/lib/api/response` + `@/lib/api/errors`. Wrap routes with `route()`.
5. Match surrounding code style (dense doc comments explaining *why*, zod `_schema.ts` files,
   `export const runtime = "nodejs"`). Next.js 16: read `web/node_modules/next/dist/docs/` before
   using `after()`, route segment config or anything version-sensitive.
6. No real people's or organisations' names in tracked files (CI name-scan).
7. Do NOT edit `src/app/api/openapi.json/route.ts`, `src/app/llms.txt/route.ts`,
   `requirements/*`, `src/lib/nav/nav-config.ts` — a later wave owns them. List every new route you
   add (method, path, auth, scope, body, response) in your report so it can be documented.

## File ownership
| Worker | Owns |
|---|---|
| W1 governance | `supabase/migrations/20261016000045_principal_four_eyes.sql`; `src/lib/auth/guard.ts` (principal resolution only — Actor type already extended), `src/lib/auth/tokens.ts`, `src/lib/auth/scopes.ts`; `src/lib/governance/decide.ts` (+ tests); every route that CREATES or DECIDES a deletion request, change request, timesheet submission or rebaseline (`api/tasks/[id]`, `api/projects/[id]`, `api/deletion-requests/**`, `api/change-requests/**`, `api/projects/[id]/change-requests`, `api/timesheet-submissions/**` + the timesheet submit route, `api/rebaselines/**`, `api/projects/[id]/rebaselines`), `src/app/api/change-requests/_schema.ts`, `src/lib/audit/coverage.test.ts`, `src/lib/audit/rpc-provenance.test.ts`, `src/lib/assistant/token.ts` (created_by only), seed scripts under `web/scripts/seed-*.mjs` (edit only, never run), `.github/workflows/e2e-smoke.yml` (read; edit only if its tokens would break) |
| W2 agent surface | `src/app/api/review/**` (new), `src/lib/review/**` (new), `web/mcp/tools.mjs` + its tests, `cli/commands/review.mjs` (new) + CLI registration + CLI tests, `src/app/api/health/route.ts`, `src/app/api/mcp/route.ts` |
| W3a hub core | `supabase/migrations/20261016000046_integration_hub.sql`; `src/lib/integrations/{types,emit,store,secrets,deliveries,inbound,identity,cron,digest-data}.ts` (+ tests) — `types.ts` and `emit.ts` stubs exist, keep the exported signatures; `src/lib/audit/write.ts`; `src/app/api/integrations/connectors/**`, `src/app/api/integrations/identities/**`, `src/app/api/integrations/cron/route.ts`; `web/vercel.json` |
| W3b Lark adapter | `src/lib/integrations/lark/**` (+ tests, fixtures); `src/app/api/integrations/lark/**`; `web/scripts/lark-worker.mjs`; `web/package.json` + `package-lock.json` (add `@larksuiteoapi/node-sdk` exactly `1.74.0`, plus `"lark:worker": "node scripts/lark-worker.mjs"`) |
| W4 ICS feed | `supabase/migrations/20261016000047_calendar_feeds.sql`; `src/lib/calendar/**` (+ tests); `src/app/api/calendar/**`; `src/app/api/calendar-feeds/**` |
| W5 docs drift | `docs/use-cases/**`, `docs/guide/**`, `docs/DEMO_SCRIPT.md`, `README.md` (text accuracy only) |

## Shared interfaces (already stubbed by the orchestrator — implement, don't rename)

`src/lib/auth/guard.ts` — `Actor` gained `principalId?`, `viaConnectorId?`, `externalEventId?`,
`externalActorRef?`. `src/lib/audit/channel.ts` — `AuditChannel` gained `"lark"` (server-derived
only; not accepted from `X-NoPM-Client`).

`src/lib/integrations/types.ts` — `ApprovalKind`, `ApprovalRef`, `ApprovalEvent`,
`ApprovalDecidedEvent`, `LarkRegion`, `LarkConfig`, `LarkSecrets`, `ConnectorRow`.

`src/lib/integrations/emit.ts` — `emitApprovalRequested(ev)` / `emitApprovalDecided(ev)`:
synchronous, never throw, schedule async work. **W1 calls them** at every request-creation and
decision point (after the audit row is written). **W3a implements them.**

`src/lib/governance/decide.ts` — **W1 implements**, **W3a's inbound pipeline calls**
`decideApproval(actor, ref, action, note)`; the REST decision routes become thin wrappers over the
same per-kind functions so UI, CLI, MCP and Lark share one governed code path.

### W1 detail — principal four-eyes
- `verifySession` → `principalId = user.id`. `verifyBearer` → select `created_by`;
  `principalId = created_by ?? null`.
- Migration 0045 (additive + backfilled): `requested_principal_id` / decided-or-approved
  `*_principal_id` on `deletion_requests`, `change_requests`, `timesheet_submissions`,
  `rebaselines` + `rebaseline_signoffs`; backfill user rows from the user id and token rows from
  `api_tokens.created_by`; CHECKs `decider_principal is null or requester_principal is null or
  decider_principal <> requester_principal`. Recreate `nopm_commit_task_deletion` and
  `nopm_commit_project_deletion` with an added `p_approver_principal_id uuid` and **DROP the old
  overloads** (an old signature left callable is a bypass). Inside: null principal →
  `raise 'NO_PRINCIPAL'` (map to 403), same principal → `SELF_APPROVAL`. Keep 0044 provenance
  params. Update the 0022 rebaseline trigger to compare principals.
- API guards compare `actor.principalId` against the stored requester principal (and keep the
  legacy actor-id checks). Null `actor.principalId` on any decide/approve → 403 "This token has no
  recorded owner, so it cannot approve (four-eyes)".
- Change request: add a compare-and-set on status in the decision UPDATE (`.in("status",
  ["raised","under_review"])`, 0 rows → 422 already decided). `createChangeRequestSchema` must not
  accept `status` values other than the raise-time ones (UC-10: today a raw DB error leaks).
- Deletion approve: accept optional `{ note }` body and record it in the audit `after` (UC-12: the
  dialog's note is silently dropped today).
- Rebaseline sign-off by a token: use the principal as `approver_id`; null → 403 (today: FK 500).
- Wildcards (D2) in `hasScope`; export `PRIVILEGED_SCOPES`.
- Tests: regression "requester approves own request with own PAT → 403" for all four kinds;
  wildcard tests; NO_PRINCIPAL; existing tests stay green. Update seed scripts so seeded maker and
  checker tokens have different `created_by`.
- `decideApproval(actor, {kind,id}, "approve"|"reject", note)`: approve → task/project deletion
  commit RPC, change request decision `approve`, timesheet `approved`; reject → deletion reject,
  change `reject`, timesheet `rejected`. `note` is required non-empty for reject; for approve
  default to the kind's existing default. Return `DecisionResult`.
- Call `emitApprovalRequested` when a deletion request / change request / timesheet submission is
  created, and `emitApprovalDecided` after every approve/reject/withdraw/reopen commit.

### W3a detail — hub core
Migration 0046 (all tables `workspace_id` + RLS enabled with NO policies = service-role only, like
`assistant_credentials`):
- `integration_connectors(id, workspace_id, kind text check in ('lark'), name, status check in
  ('active','paused','revoked'), config jsonb (LarkConfig), secret_enc text, relay_secret_hash
  text, created_by, created_at, updated_at, revoked_at)`; one active lark connector per workspace
  (partial unique index).
- `external_identities(id, workspace_id, connector_id, provider, external_tenant, external_user_id,
  external_union_id, display_name, profile_id, linked_at, revoked_at)`; unique active
  `(connector_id, external_tenant, external_user_id)` and one active link per
  `(connector_id, profile_id)`.
- `identity_link_codes(id, workspace_id, connector_id, profile_id, code_hash, expires_at, used_at,
  created_at)`.
- `integration_deliveries(id, workspace_id, connector_id, kind text ('approval_card',
  'decision_update','digest','bot_reply'), approval_kind, approval_id, recipient_profile_id,
  external_target text, payload jsonb, status ('pending','sent','retry','dead','superseded'),
  attempts int, next_attempt_at, external_message_id, last_error text (truncated, no secrets),
  created_at, sent_at)`.
- `inbound_actions(id, workspace_id, connector_id, external_event_id, action, approval_kind,
  approval_id, principal_id, outcome jsonb, received_at)`; unique `(connector_id,
  external_event_id)` — a replay returns the stored outcome with no second mutation.
- `action_tokens(id, workspace_id, delivery_id, recipient_profile_id, approval_kind, approval_id,
  token_hash, expires_at, used_at)`; single use, recipient-bound, TTL 7 days.
- `audit_log`: extend the `channel` CHECK with `'lark'`; add nullable `via_connector_id uuid`,
  `external_event_id text`, `external_actor_ref text`. Touch NOTHING else on audit_log (no
  policy/trigger change). `writeAudit` writes the three new fields from the Actor.
- Secrets: `encrypt(JSON.stringify(LarkSecrets))` via `@/lib/crypto`; never returned by any API;
  API responses expose `has_encrypt_key`, `app_id`, masked fields only.
- Inbound pipeline `handleApprovalAction({connector, externalEventId, externalTenant,
  externalUserId, actionToken, action, note})` → idempotency insert → identity lookup (active) →
  profile (role, workspace) → consume action token atomically (unused, unexpired, recipient =
  profile, matches approval) → build `Actor{type:'user', id: profile.id, principalId: profile.id,
  role, label, workspaceId, channel:'lark', viaConnectorId, externalEventId, externalActorRef}` →
  `decideApproval` → store outcome. Every failure returns a typed outcome (`unlinked`,
  `expired`, `not_recipient`, `self_approval`, `already_decided`, `forbidden`, `error`) the
  adapter turns into a toast; never throws to the platform.
- Delivery queue: `emitApprovalRequested` resolves recipients (`resolveWorkspaceApprovers` minus
  requester principal, active linked identity on the workspace's active lark connector, role
  admin/manager), mints an action token per recipient, inserts `pending` deliveries, then
  `after(() => drainDeliveries(...))`. Rendering + sending are done by an adapter function
  registered by W3b: `import { larkAdapter } from "@/lib/integrations/lark"` exposing
  `renderApprovalCard`, `renderDecisionUpdate`, `renderDigest`, `send`, `update` (see
  `types.ts` `ConnectorAdapter`). `emitApprovalDecided` supersedes the request's open tokens and
  enqueues `decision_update` patches for every sent card of that approval.
- Retry: attempts 1m, 5m, 30m, 2h, 12h, then `dead`. `cron.ts` = drain due retries + weekly digest
  (connector config `digest.weekday` 0-6, sent once per ISO week, tracked via deliveries).
- Routes: `GET/POST /api/integrations/connectors` (admin only, audited `integration.connector.create`;
  POST returns the relay secret ONCE), `PATCH/DELETE /api/integrations/connectors/[id]`
  (`.update` / `.revoke`, revoke also revokes identities), `POST
  /api/integrations/connectors/[id]/test` (calls adapter `testConnection`, audited? no — read),
  `POST /api/integrations/connectors/[id]/digest` (send now, audited `integration.digest.send`),
  `POST /api/integrations/identities/link-code` (any signed-in member, audited
  `integration.identity.code`), `GET /api/integrations/identities` (mine; admin sees all),
  `DELETE /api/integrations/identities/[id]` (self or admin, audited `integration.identity.unlink`),
  `GET /api/integrations/cron` (`auth:false`, constant-time Bearer `CRON_SECRET` check).
  Identity LINK itself (from the bot DM) is audited `integration.identity.link` with the code
  owner as actor and `channel='lark'`.
- `web/vercel.json`: add `"crons": [{ "path": "/api/integrations/cron", "schedule": "0 1 * * *" }]`.

### W3b detail — Lark adapter
- `src/lib/integrations/lark/client.ts`: SDK `Client` per connector (`appId`, `appSecret`,
  `domain: region === 'feishu' ? Domain.Feishu : Domain.Lark`), tenant token caching handled by
  the SDK. Send interactive message to `open_id` (DM) or `chat_id`; patch a sent card.
  `testConnection` = fetch bot info. Respect 429 (`x-ogw-ratelimit-reset`).
- `cards.ts`: card JSON 2.0 builders (pure, snapshot-tested): approval request (title, project,
  requester, summary, deep link, Approve button, Reject button opening a form with a required
  reason input), decided state (who, channel, when — no buttons), digest, link confirmation, help.
  Buttons carry `value: { t: <raw action token>, a: 'approve'|'reject' }` only. Deep links use
  `NEXT_PUBLIC_APP_URL` (never hard-code stillnotbald.com).
- `verify.ts`: webhook authenticity — `X-Lark-Signature` = sha256(timestamp + nonce + encryptKey
  + rawBody) when an encrypt key is set (constant-time compare, ±5 min window) and AES-256-CBC
  decrypt of `{encrypt}` (key = sha256(encryptKey), IV = first 16 bytes); otherwise compare the
  payload `token` / `header.token` with the verification token. Read the SDK source in
  `node_modules/@larksuiteoapi/node-sdk` to confirm formats and reuse its helpers where they apply;
  card 2.0 callbacks may not be covered by the SDK — then hand-roll. Fixture-tested.
- Routes (`auth:false`, rate-limited per connector): `POST
  /api/integrations/lark/[connectorId]/events` (url_verification challenge; `im.message.receive_v1`
  DM commands: `help`, `link <code>`, `approvals` — anything else → help card),
  `POST /api/integrations/lark/[connectorId]/card` (`card.action.trigger` → W3a
  `handleApprovalAction` → respond within 3 s with toast + replacement card),
  `POST /api/integrations/lark/[connectorId]/relay` (from the self-host worker: HMAC-SHA256 over
  `timestamp.body` with the connector relay secret, ±5 min; then the same handlers).
- `web/scripts/lark-worker.mjs`: zero-build Node script: `WSClient` + `EventDispatcher` for
  `im.message.receive_v1` and `card.action.trigger`; relays to
  `${NOPM_APP_URL}/api/integrations/lark/${NOPM_LARK_CONNECTOR_ID}/relay`; returns the relay's
  JSON to the SDK for card responses; one instance only (document why). Env:
  `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_REGION`, `NOPM_APP_URL`, `NOPM_LARK_CONNECTOR_ID`,
  `NOPM_LARK_RELAY_SECRET`.
- Export `larkAdapter: ConnectorAdapter` from `src/lib/integrations/lark/index.ts`.

### W4 detail — ICS feed
- Migration 0047 `calendar_feeds(id, workspace_id, name, project_id null, token_hash unique,
  created_by, created_at, last_fetched_at, revoked_at)`, RLS no policies.
- `src/lib/calendar/ics.ts` pure builder (RFC 5545: CRLF, 75-octet folding, TEXT escaping, stable
  `UID` = `milestone-<id>@<host>`, `DTSTAMP`, all-day `DTSTART;VALUE=DATE` + `DTEND` next day,
  `SEQUENCE` from updated_at epoch, `X-WR-CALNAME`, `URL` deep link). Tests.
- `POST /api/calendar-feeds` (any non-viewer; body `{name, project_id?}`; returns `{ url }` ONCE;
  token `npc_` + 32 random bytes base64url, SHA-256 stored; audited `calendar_feed.create`),
  `GET /api/calendar-feeds` (mine), `DELETE /api/calendar-feeds/[id]` (owner or admin, audited
  `calendar_feed.revoke`), `GET /api/calendar/[token]` (`auth:false`; accepts `npc_….ics`;
  workspace-filtered milestones (+ project filter); `text/calendar; charset=utf-8`,
  `Cache-Control: private, max-age=900`, `Referrer-Policy: no-referrer`; 404 on unknown/revoked;
  updates `last_fetched_at` fire-and-forget; not audited per fetch).

### W5 detail — docs drift (from `docs/research/audit-2026-10-16/02-user-journeys.md`)
UC-08 decision values are `approved` / `rejected` / `reopened`; UC-10 required fields + 422;
UC-12 lock pre-check exists at request time and the approve note is now recorded; UC-17 must say
four-eyes is enforced between HUMANS (principal = the person, or the person who created the token)
and wildcard scopes never grant approve/decide; UC-22 docker-compose ships (R-88); demo login is a
manager, not a viewer; diagrams for all 8 process flows exist (remove "planned"). Change only
what is wrong; keep each doc's voice.

## Gates at wave end (orchestrator)
`npx tsc --noEmit` · `npm run lint` · `npm run test` · CLI tests · `npm run rtm:verify` ·
`npm run build` (dummy env) · local Supabase (`npx supabase start`) migration apply + RPC
four-eyes probe + Lark inbound probe with a fake signed callback · adversarial review agents.

## Additional workers (fleet widened 2026-10-16)
| Worker | Owns |
|---|---|
| W3c self-host relay | `web/scripts/lark-worker.mjs` (+ `web/scripts/lark-worker.test.mjs` if testable), `src/app/api/integrations/lark/[connectorId]/relay/route.ts`, `src/lib/integrations/lark/relay.ts` (HMAC verify of relayed events), `docs/guide/07-lark-integration.md` (owner/admin setup guide: create a Lark or Feishu self-built app, scopes, event + callback config, webhook vs long-connection, link your account, digest, troubleshooting). W3b therefore does NOT own the worker script or the relay route. |
| W6 integrations UI | `src/app/(console)/integrations/**` (new page), `src/components/integrations/**`. Builds against the route contract in this PLAN (APIs land in parallel). |
| W8 ADRs + new use cases | `docs/adr/0012-integration-hub-fan-out-boundary.md`, `docs/adr/0013-principal-aware-four-eyes.md`, `docs/use-cases/UC-23-approve-from-lark.md`, `UC-24-link-lark-account.md`, `UC-25-lark-weekly-digest.md`, `UC-26-calendar-feed-subscription.md` (new files only; W5 owns existing UC files + the README index). |
| W9 local-DB probes | `web/scripts/local-db/**` (new): scripts the orchestrator runs against a LOCAL Supabase (`npx supabase start`, never the live project) to prove migrations apply in order and the four-eyes/principal rules hold at the DB layer, plus a fake signed Lark callback probe. Write only; do not run against any remote URL. |

Extra hard rule: the repo's leak gate (`scripts/commit-gate.mjs`) blocks absolute user-profile
paths and AI model product names (e.g. the names of model tiers) in tracked files — say "agent"
or "worker", never a model name, and use repo-relative paths.

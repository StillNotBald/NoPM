-- NoPM · 0046 integration_hub — event fan-out + identity-verified chat actions
-- (Lark v1; sprint-log/2026-10-16_lark-integration/PLAN.md, W3a).
--
-- The hub is FAN-OUT, not an automations engine: fixed message types to fixed
-- recipients, plus exactly one inbound mutation — a human, identity-verified,
-- single-use approve/reject on a governed request that already exists. That
-- decision runs through the same governed code path as the REST routes, so
-- four-eyes, scopes, locks and the one-audit-row rule apply unchanged.
--
-- Sensitive precedent (0014 assistant_credentials, 0039 invites): every table
-- below carries workspace_id, has RLS ENABLED with ZERO policies, and has all
-- anon/authenticated privileges revoked = deny-all. Only the service-role admin
-- client (inside route() handlers and the hub's own server code) reads or
-- writes them, and every query there filters workspace_id. Connector secrets
-- are AES-256-GCM ciphertext (src/lib/crypto.ts) and are never returned by an
-- API; action tokens, link codes and the relay secret are stored as SHA-256
-- hashes only (shown once at creation).

-- ── integration_connectors ─────────────────────────────────────────────────
create table integration_connectors (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  kind              text not null check (kind in ('lark')),
  name              text not null,
  -- 'paused' is the workspace kill switch: it stops BOTH directions (no
  -- outbound drain, every inbound callback is refused).
  status            text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  config            jsonb not null default '{}'::jsonb,   -- LarkConfig (non-secret)
  secret_enc        text not null,                        -- AES-256-GCM(JSON LarkSecrets)
  relay_secret_hash text,                                 -- sha-256(raw relay secret); raw shown once
  -- The platform tenant this connector is pinned to: set atomically by the FIRST
  -- successful identity link, after which events from any other tenant are refused
  -- in both directions (matters for store apps any tenant can install). An admin
  -- clears it (PATCH clear_tenant_pin) to re-pin to a different tenant.
  tenant_key        text,
  created_by        uuid references profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  revoked_at        timestamptz
);
create index on integration_connectors(workspace_id);
-- One live (active or paused) connector per kind per workspace. A revoked
-- connector frees the slot so the owner can connect a replacement app.
create unique index uniq_live_connector_per_kind
  on integration_connectors(workspace_id, kind) where status <> 'revoked';
create trigger trg_integration_connectors_updated before update on integration_connectors
  for each row execute function nopm_set_updated_at();

-- ── external_identities (external platform user <-> NoPM profile) ──────────
-- Created ONLY by consuming a one-time link code sent from the verified bot
-- DM — never by email match (spoofable, not a verified claim on every
-- platform). revoked_at is the soft unlink; history rows stay for the audit.
create table external_identities (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  connector_id      uuid not null references integration_connectors(id) on delete cascade,
  provider          text not null default 'lark',
  external_tenant   text not null,
  external_user_id  text not null,
  external_union_id text,
  display_name      text,
  profile_id        uuid not null references profiles(id) on delete cascade,
  linked_at         timestamptz not null default now(),
  revoked_at        timestamptz
);
create index on external_identities(workspace_id);
create index on external_identities(profile_id);
-- One external account maps to at most one profile, and one profile to at most
-- one external account, per connector (while active).
create unique index uniq_active_external_identity
  on external_identities(connector_id, external_tenant, external_user_id) where revoked_at is null;
create unique index uniq_active_profile_link
  on external_identities(connector_id, profile_id) where revoked_at is null;

-- ── identity_link_codes (NPL-XXXX-XXXX, 10 min, single use, hashed) ─────────
create table identity_link_codes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  connector_id uuid not null references integration_connectors(id) on delete cascade,
  profile_id   uuid not null references profiles(id) on delete cascade,
  code_hash    text not null unique,       -- sha-256(normalised code); raw shown once
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index on identity_link_codes(workspace_id);
create index on identity_link_codes(profile_id);

-- ── integration_deliveries (the outbound queue) ────────────────────────────
-- Bookkeeping, not governed data: the governed record is the audit_log row of
-- the request/decision itself. last_error is truncated and never carries a
-- secret or a message body.
create table integration_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  connector_id         uuid not null references integration_connectors(id) on delete cascade,
  kind                 text not null check (kind in ('approval_card', 'decision_update', 'digest', 'bot_reply')),
  approval_kind        text check (approval_kind is null or approval_kind in
                         ('task_deletion', 'project_deletion', 'change_request', 'timesheet')),
  approval_id          uuid,
  recipient_profile_id uuid references profiles(id) on delete set null,
  external_target      text,               -- open_id (DM) or chat_id (group)
  -- decision_update rows patch the card sent by this delivery; the external
  -- message id is read from the parent at drain time (covers a card that is
  -- still in flight when the decision lands).
  parent_delivery_id   uuid references integration_deliveries(id) on delete set null,
  payload              jsonb not null default '{}'::jsonb,   -- non-secret event data; NEVER an action token
  status               text not null default 'pending'
                         check (status in ('pending', 'sent', 'retry', 'dead', 'superseded')),
  attempts             int not null default 0,
  next_attempt_at      timestamptz not null default now(),
  -- Claim lease: a drain stamps this before sending so two concurrent drains
  -- (after() + cron) never double-send; a crashed drain's lease simply expires.
  locked_until         timestamptz,
  external_message_id  text,
  last_error           text,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz
);
create index on integration_deliveries(workspace_id);
create index on integration_deliveries(workspace_id, approval_kind, approval_id);
create index on integration_deliveries(connector_id, kind, created_at desc);
create index on integration_deliveries(next_attempt_at) where status in ('pending', 'retry');
-- DB backstop against a duplicate emit queueing the same card twice.
create unique index uniq_queued_approval_card
  on integration_deliveries(connector_id, approval_kind, approval_id, recipient_profile_id)
  where kind = 'approval_card' and status in ('pending', 'retry');
-- A card is patched to its decided state at most once.
create unique index uniq_decision_update_per_card
  on integration_deliveries(parent_delivery_id) where kind = 'decision_update';

-- ── action_tokens (single-use, recipient-bound, approval-bound, TTL 7d) ─────
-- One opaque token per card; the card carries only the raw token. `used_at`
-- doubles as "superseded": when a request is decided from ANY channel every
-- open token for it is stamped used, so a late click is a clean
-- already-decided, never a second mutation.
create table action_tokens (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  delivery_id          uuid not null references integration_deliveries(id) on delete cascade,
  recipient_profile_id uuid not null references profiles(id) on delete cascade,
  approval_kind        text not null check (approval_kind in
                         ('task_deletion', 'project_deletion', 'change_request', 'timesheet')),
  approval_id          uuid not null,
  token_hash           text not null unique,   -- sha-256(raw token); raw lives only in the sent card
  expires_at           timestamptz not null,
  used_at              timestamptz,
  created_at           timestamptz not null default now()
);
create index on action_tokens(workspace_id, approval_kind, approval_id);
create index on action_tokens(delivery_id);

-- ── inbound_actions (idempotency ledger) ───────────────────────────────────
-- A platform retry or a double-click carries the same external_event_id: the
-- second arrival finds this row and returns the stored outcome with no second
-- mutation and no second audit row. The row is claimed (outcome null) before
-- any work, completed with the typed outcome afterwards.
create table inbound_actions (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  connector_id      uuid not null references integration_connectors(id) on delete cascade,
  external_event_id text not null,
  action            text not null check (action in ('approve', 'reject')),
  approval_kind     text,
  approval_id       uuid,
  principal_id      uuid,
  outcome           jsonb,
  received_at       timestamptz not null default now(),
  unique (connector_id, external_event_id)
);
create index on inbound_actions(workspace_id, received_at desc);

-- ── RLS: deny-all (service role only) ──────────────────────────────────────
alter table integration_connectors enable row level security;
alter table external_identities    enable row level security;
alter table identity_link_codes    enable row level security;
alter table integration_deliveries enable row level security;
alter table action_tokens          enable row level security;
alter table inbound_actions        enable row level security;
-- Zero policies: deny-all for anon/authenticated.
revoke all on integration_connectors from anon, authenticated;
revoke all on external_identities    from anon, authenticated;
revoke all on identity_link_codes    from anon, authenticated;
revoke all on integration_deliveries from anon, authenticated;
revoke all on action_tokens          from anon, authenticated;
revoke all on inbound_actions        from anon, authenticated;

-- ── audit_log: provenance for connector-originated rows ────────────────────
-- STRICTLY additive (precedent: 0042, 0043): extend the channel CHECK with
-- 'lark' and add three nullable columns recording which connector relayed the
-- action, the platform's event id and the platform user reference (so a
-- chat-originated approval is non-repudiable). 'lark' is server-derived only —
-- it is never accepted from the X-NoPM-Client header (src/lib/audit/channel.ts).
-- NO trigger or policy is touched: append-only immutability and the
-- member-read policy apply unchanged to the new columns.
alter table audit_log drop constraint audit_channel_check;
-- NOT VALID then VALIDATE: the new constraint is registered instantly and the
-- existing rows are checked in a separate step (the runner wraps the file in
-- one transaction, so the table lock is held until commit either way — the
-- check is a single read-only pass over a value set that only widened).
alter table audit_log
  add constraint audit_channel_check
  check (channel is null or channel in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark'))
  not valid;
alter table audit_log validate constraint audit_channel_check;

alter table audit_log
  add column via_connector_id  uuid,
  add column external_event_id text,
  add column external_actor_ref text;

comment on column audit_log.via_connector_id is 'integration connector that relayed this action (server-derived; null for first-party channels)';
comment on column audit_log.external_event_id is 'the external platform''s event/callback id for a connector-relayed action';
comment on column audit_log.external_actor_ref is 'the external platform user reference, e.g. lark:<tenant>:<open_id>';

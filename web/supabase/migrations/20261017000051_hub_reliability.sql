-- NoPM · 0051 hub_reliability — Integration Hub reliability fixes.
-- Additive only: two indexes the code relies on, three indexes for the new
-- retention and health queries, and one small bookkeeping table. Nothing here
-- touches audit_log, a governed table, or any 0046 object's definition.

-- ── One scheduled digest per connector per ISO week (atomic claim) ─────────
-- The weekly digest used to be "check, then insert", so concurrent cron ticks
-- (or a cron event the platform delivers twice) each queued one and each wrote
-- an audit row. The producer now claims the week by INSERTing the delivery row
-- under this unique index and treats 23505 as "already queued". The key is the
-- Monday date of the ISO week (payload.week_start). Superseded rows release the
-- slot (a retired row must not block a fresh one). Rows written before this
-- migration carry no week_start: NULL keys are distinct in a unique index, so
-- they can never collide. A manual "send now" digest has trigger 'manual' and
-- is outside the index, so it never uses up the week's slot.
create unique index uniq_scheduled_digest_per_week
  on integration_deliveries (connector_id, (payload->>'week_start'))
  where kind = 'digest' and payload->>'trigger' = 'scheduled' and status <> 'superseded';

-- ── Retention + health lookups ─────────────────────────────────────────────
-- The daily cron deletes terminal deliveries, long-expired action tokens and
-- completed inbound idempotency rows in bounded batches per workspace, and the
-- admin connector view counts a connector's deliveries by status.
create index integration_deliveries_terminal_idx
  on integration_deliveries (workspace_id, created_at)
  where status in ('sent', 'dead', 'superseded');
create index integration_deliveries_connector_status_idx
  on integration_deliveries (connector_id, status);
create index action_tokens_expiry_idx
  on action_tokens (workspace_id, expires_at);

-- ── integration_cron_state (what the last scheduler tick did, per connector) ─
-- Delivery is best-effort, so without this a scheduler that never runs (an
-- unset or padded CRON_SECRET answers every call 401) is indistinguishable from
-- a quiet week. One row per connector, written by the cron after it processes
-- the connector and read by the admin connector view. Counts only: no message
-- text, no identifiers beyond the connector.
--
-- Same posture as every 0046 table: workspace_id, RLS enabled with ZERO policies,
-- all anon/authenticated privileges revoked = service role only.
create table integration_cron_state (
  connector_id  uuid primary key references integration_connectors(id) on delete cascade,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  last_run_at   timestamptz not null,
  last_summary  jsonb not null default '{}'::jsonb
);
create index on integration_cron_state(workspace_id);

alter table integration_cron_state enable row level security;
revoke all on integration_cron_state from anon, authenticated;

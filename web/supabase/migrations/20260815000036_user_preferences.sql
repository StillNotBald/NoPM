-- NoPM · 0036 user_preferences — per-user DB-persisted display config (L-39).
-- RLS enabled with ZERO policies = deny-all for anon/authenticated.
-- Only the service-role admin client (bypasses RLS) reads/writes this table,
-- via GET/PUT /api/me/preferences — mirrors assistant_credentials (0014).
--
-- Composite PK (user_id, workspace_id): one preferences row per user PER
-- WORKSPACE (NoPM's identity model is single-workspace-per-profile today,
-- but the composite key mirrors assistant_credentials' workspace_id column
-- and keeps the row inherently workspace-scoped rather than relying on the
-- API layer alone to enforce it).
--
-- `config` is a closed-shape jsonb payload (validated by the Zod schema at
-- web/src/app/api/me/preferences/_schema.ts, NOT by a DB CHECK — same split
-- saved_views.config uses): columns (per register), groupBy (per register),
-- density, dateDisplay, defaultLanding. Per ADR 0009 (amended for this
-- table): these are per-user DISPLAY preferences, not governance state — no
-- writeAudit call anywhere in the API route.

create table user_preferences (
  user_id      uuid        not null references profiles(id) on delete cascade,
  workspace_id uuid        not null references workspaces(id) on delete cascade,
  config       jsonb       not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),

  primary key (user_id, workspace_id)
);

create index on user_preferences(workspace_id);

alter table user_preferences enable row level security;
-- Zero policies: deny-all. Only the service-role admin client accesses this table.

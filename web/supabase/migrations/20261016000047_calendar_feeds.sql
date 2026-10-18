-- NoPM · 0047 calendar feeds — revocable secret-URL ICS subscriptions for
-- milestones (PLAN D10). Apple, Outlook, Google and Lark calendars all accept a
-- plain https subscription URL, so the feed needs no OAuth and no integration
-- connector: the secret in the URL is the credential.
--
-- Sensitive precedent (mirrors api_tokens/0002 and invites/0039): RLS enabled
-- with ZERO policies = deny-all for anon/authenticated. Every read and write
-- goes through the audited API routes on the service-role admin client.
--
-- The raw token is never stored. Only sha-256(raw) lives here, so a database
-- read cannot be replayed as a subscription URL (same rule as api_tokens).
--
-- project_id NULL = the feed covers every scheduled milestone in the workspace.
-- Revocation is soft (revoked_at) so the owner's list and the audit trail keep
-- a record of what existed; the public feed route 404s on any revoked row.
create table calendar_feeds (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 255),
  project_id      uuid references projects(id) on delete cascade,
  token_hash      text not null unique,   -- sha-256(raw 'npc_' token); raw shown once
  created_by      uuid not null references profiles(id),
  created_at      timestamptz not null default now(),
  last_fetched_at timestamptz,
  revoked_at      timestamptz
);

create index on calendar_feeds(workspace_id);

alter table calendar_feeds enable row level security;
-- Zero policies: deny-all for anon/authenticated (see header).
revoke all on calendar_feeds from anon, authenticated;

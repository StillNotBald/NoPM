-- NoPM · 0002 identity — TOTP MFA + scoped API tokens.
-- Both are sensitive: RLS enabled with ZERO policies = deny-all for anon/authenticated.
-- Only the service-role admin client (bypasses RLS) reads/writes these; the
-- /api/tokens routes return sanitized rows (never the hash).

create table user_mfa (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  totp_secret  text not null,                       -- base32 TOTP secret
  enabled      boolean not null default false,
  backup_codes text[] not null default '{}',        -- store HASHES only
  enrolled_at  timestamptz not null default now(),
  confirmed_at timestamptz
);

create table api_tokens (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,                -- sha-256(raw token); raw shown once
  prefix       text not null default 'npm_',
  scopes       text[] not null default '{}',        -- e.g. {task:read,task:write,task:delete:request}
  created_by   uuid references profiles(id),
  expires_at   timestamptz,
  revoked      boolean not null default false,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);
create index on api_tokens(workspace_id);
create index on api_tokens(token_hash);

alter table user_mfa   enable row level security;
alter table api_tokens enable row level security;

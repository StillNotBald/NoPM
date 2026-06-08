-- NoPM · 0014 assistant_credentials — per-user LLM API key storage.
-- RLS enabled with ZERO policies = deny-all for anon/authenticated.
-- Only the service-role admin client (bypasses RLS) reads/writes this table.
-- The api_key_enc column stores AES-256-GCM encrypted ciphertext (iv.authTag.ciphertext).

create table assistant_credentials (
  id          uuid        primary key default gen_random_uuid(),
  workspace_id uuid       not null references workspaces(id) on delete cascade,
  user_id     uuid        not null references profiles(id) on delete cascade,
  provider    text        not null,        -- e.g. 'openai', 'anthropic', 'google'
  api_key_enc text        not null,        -- AES-256-GCM encrypted; never returned to client
  model       text        not null,        -- e.g. 'gpt-4o', 'claude-opus-4-5'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (user_id)
);

create index on assistant_credentials(workspace_id);

alter table assistant_credentials enable row level security;
-- Zero policies: deny-all. Only the service-role admin client accesses this table.

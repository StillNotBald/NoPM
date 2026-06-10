-- NoPM · 0025 assistant_conversations — persisted chat history.
-- RLS enabled with ZERO policies = deny-all for anon/authenticated.
-- Only the service-role admin client (bypasses RLS) reads/writes these tables.
-- The API enforces ownership by filtering on user_id + workspace_id.

create table assistant_conversations (
  id           uuid        primary key default gen_random_uuid(),
  workspace_id uuid        not null references workspaces(id) on delete cascade,
  user_id      uuid        not null references profiles(id) on delete cascade,
  title        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index on assistant_conversations(user_id, created_at desc);
create index on assistant_conversations(workspace_id);

alter table assistant_conversations enable row level security;
-- Zero policies: deny-all. Only the service-role admin client accesses this table.

create table assistant_messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references assistant_conversations(id) on delete cascade,
  role            text        not null check (role in ('user', 'assistant')),
  content         text        not null,
  actions         jsonb,
  created_at      timestamptz not null default now()
);

create index on assistant_messages(conversation_id, created_at);

alter table assistant_messages enable row level security;
-- Zero policies: deny-all. Only the service-role admin client accesses this table.

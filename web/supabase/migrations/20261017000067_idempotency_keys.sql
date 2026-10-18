-- NoPM · 0067 (2026-10-17) — idempotency_keys: replay store for create endpoints.
--
-- WHY. An agent or CLI that retries a POST after a timeout would create the
-- record twice. Callers may send `Idempotency-Key: <token>`; the server runs the
-- create once per (workspace, actor, route, key) and replays the stored JSON
-- result for any retry within 24 hours (see web/src/lib/api/idempotency.ts).
--
-- Server-only table: RLS on with NO policies, so only the service role reaches it.
-- ROLLBACK. remove the table idempotency_keys (nothing else references it).

create table if not exists idempotency_keys (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_id     text not null,
  route        text not null,
  key          text not null check (char_length(key) between 1 and 200),
  result       jsonb not null,
  created_at   timestamptz not null default now()
);

create unique index if not exists idempotency_keys_unique
  on idempotency_keys (workspace_id, actor_id, route, key);

create index if not exists idempotency_keys_created_at_idx
  on idempotency_keys (created_at);

alter table idempotency_keys enable row level security;

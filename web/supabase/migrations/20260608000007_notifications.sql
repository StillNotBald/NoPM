-- NoPM · 0007 notifications — in-app notification center (email sender is demo-mode).

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  type         text not null,            -- e.g. 'approval.requested', 'risk.escalated'
  title        text not null,
  body         text,
  payload      jsonb,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index on notifications(recipient_id, read_at);

alter table notifications enable row level security;
-- A user sees only their own notifications. Inserts happen via the service-role client.
create policy "read own notifications" on notifications
  for select using (recipient_id = auth.uid());
create policy "update own notifications" on notifications
  for update using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

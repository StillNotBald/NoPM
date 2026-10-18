-- NoPM · 0098 project snapshots (B6).
-- One row per project per day, written by the nightly snapshot cron
-- (/api/cron/snapshots) with the service role. The trend and the suggested RAG are
-- computed from these rows; the suggestion never overwrites the declared RAG.
-- Select-only for members (RLS); there is no insert/update/delete policy, so only the
-- service role writes. No backfill: history starts the day this is applied.
--
-- Project-deletion guard: this table cascades from projects. Migration 0099 (W3-D) extends
-- nopm_project_child_counts to count project_snapshots; it is NOT redefined here.

create table if not exists project_snapshots (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  project_id        uuid not null references projects(id) on delete cascade,
  taken_at          date not null,
  spi               numeric(8,3),
  cpi               numeric(8,3),
  eac               numeric(16,2),
  planned_end       date,
  forecast_end      date,
  slip_days         int,
  completion_pct    numeric(5,2),
  open_risks_high   int not null default 0,
  rag_declared      text,
  rag_suggested     text,
  created_at        timestamptz not null default now(),
  constraint project_snapshots_project_day_uniq unique (project_id, taken_at),
  constraint project_snapshots_rag_suggested_chk
    check (rag_suggested is null or rag_suggested in ('green', 'amber', 'red'))
);

create index if not exists project_snapshots_ws_day_idx on project_snapshots (workspace_id, taken_at desc);

alter table project_snapshots enable row level security;

drop policy if exists "read_project_snapshots" on project_snapshots;
create policy "read_project_snapshots" on project_snapshots
  for select using (workspace_id = nopm_current_workspace());

revoke insert, update, delete on project_snapshots from anon, authenticated;

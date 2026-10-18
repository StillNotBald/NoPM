-- NoPM · 0003 PM core — projects, milestones, tasks (typed statuses).

create type milestone_status as enum ('not_started', 'on_track', 'at_risk', 'delayed', 'completed');
create type task_status_type as enum ('backlog', 'unstarted', 'started', 'completed', 'canceled');
create type priority_level   as enum ('low', 'medium', 'high', 'urgent');

create table projects (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  code           text,
  name           text not null,
  description    text,
  program        text,
  owner_id       uuid references profiles(id),
  rag_status     rag_status not null default 'not_started',
  completion_pct numeric(5,2) not null default 0 check (completion_pct between 0 and 100),
  start_date     date,
  target_date    date,
  currency       text not null default 'MYR',
  is_locked      boolean not null default false,
  locked_by      uuid references profiles(id),
  locked_at      timestamptz,
  lock_reason    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on projects(workspace_id);
create trigger trg_projects_updated before update on projects
  for each row execute function nopm_set_updated_at();

create table milestones (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  project_id     uuid not null references projects(id) on delete cascade,
  name           text not null,
  target_date    date,
  status         milestone_status not null default 'not_started',
  completion_pct numeric(5,2) not null default 0 check (completion_pct between 0 and 100),
  owner_id       uuid references profiles(id),
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on milestones(project_id);
create trigger trg_milestones_updated before update on milestones
  for each row execute function nopm_set_updated_at();

create table tasks (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  project_id     uuid not null references projects(id) on delete cascade,
  milestone_id   uuid references milestones(id) on delete set null,
  name           text not null,
  description    text,
  status         text not null default 'Backlog',          -- display label
  status_type    task_status_type not null default 'backlog',  -- machine-reasonable
  assignee_id    uuid references profiles(id),
  priority       priority_level not null default 'medium',
  start_date     date,
  due_date       date,
  completion_pct numeric(5,2) not null default 0 check (completion_pct between 0 and 100),
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on tasks(project_id);
create index on tasks(milestone_id);
create trigger trg_tasks_updated before update on tasks
  for each row execute function nopm_set_updated_at();

-- ── RLS: workspace-scoped; viewers read-only, others read+write ────────────
alter table projects   enable row level security;
alter table milestones enable row level security;
alter table tasks      enable row level security;

create policy "read projects"  on projects for select using (workspace_id = nopm_current_workspace());
create policy "write projects" on projects for all
  using (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer')
  with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer');

create policy "read milestones"  on milestones for select using (workspace_id = nopm_current_workspace());
create policy "write milestones" on milestones for all
  using (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer')
  with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer');

create policy "read tasks"  on tasks for select using (workspace_id = nopm_current_workspace());
create policy "write tasks" on tasks for all
  using (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer')
  with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer');

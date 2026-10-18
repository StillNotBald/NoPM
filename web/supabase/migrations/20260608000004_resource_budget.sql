-- NoPM · 0004 resource & budget — the iron-triangle layer most PMO tools miss.

create table resource_members (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references workspaces(id) on delete cascade,
  name                    text not null,
  email                   text,
  role_title              text,
  cost_rate               numeric(12,2) not null default 0,   -- per hour
  capacity_hours_per_week numeric(6,2)  not null default 40,
  profile_id              uuid references profiles(id),        -- optional link to a login user
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index on resource_members(workspace_id);
create trigger trg_resource_members_updated before update on resource_members
  for each row execute function nopm_set_updated_at();

create table allocations (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  member_id      uuid not null references resource_members(id) on delete cascade,
  project_id     uuid references projects(id) on delete cascade,
  task_id        uuid references tasks(id) on delete cascade,
  allocation_pct numeric(5,2) not null default 0 check (allocation_pct between 0 and 100),
  hours          numeric(8,2),
  window_start   date,
  window_end     date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on allocations(member_id);
create index on allocations(project_id);
create trigger trg_allocations_updated before update on allocations
  for each row execute function nopm_set_updated_at();

create table time_entries (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  member_id    uuid not null references resource_members(id) on delete cascade,
  task_id      uuid references tasks(id) on delete set null,
  project_id   uuid references projects(id) on delete cascade,
  entry_date   date not null default current_date,
  hours        numeric(6,2)  not null default 0,
  cost         numeric(12,2) not null default 0,   -- snapshot: hours * member rate at entry
  note         text,
  created_at   timestamptz not null default now()
);
create index on time_entries(member_id);
create index on time_entries(project_id);

create table project_budget (
  project_id       uuid primary key references projects(id) on delete cascade,
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  planned_amount   numeric(14,2) not null default 0,
  committed_amount numeric(14,2) not null default 0,
  currency         text not null default 'MYR',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_project_budget_updated before update on project_budget
  for each row execute function nopm_set_updated_at();

create table expenses (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  description  text not null,
  amount       numeric(14,2) not null default 0,
  category     text,
  incurred_on  date not null default current_date,
  created_at   timestamptz not null default now()
);
create index on expenses(project_id);

-- ── RLS: workspace-scoped; viewers read-only, others read+write ────────────
do $$
declare t text;
begin
  foreach t in array array['resource_members','allocations','time_entries','project_budget','expenses']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy "read_%1$s" on %1$I for select using (workspace_id = nopm_current_workspace())', t);
    execute format(
      'create policy "write_%1$s" on %1$I for all '
      'using (workspace_id = nopm_current_workspace() and nopm_current_role() <> ''viewer'') '
      'with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> ''viewer'')', t);
  end loop;
end $$;

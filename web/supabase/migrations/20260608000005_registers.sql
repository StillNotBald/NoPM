-- NoPM · 0005 registers — risks, issues, clashes (clash = cross-project conflict).

create type severity_level as enum ('low', 'medium', 'high', 'critical');
create type risk_status    as enum ('open', 'mitigating', 'closed', 'accepted');
create type issue_status   as enum ('open', 'in_progress', 'resolved', 'closed');
create type clash_type     as enum ('schedule', 'resource', 'dependency');
create type clash_status   as enum ('open', 'investigating', 'resolved');

create table risks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  title        text not null,
  description  text,
  severity     severity_level not null default 'medium',
  likelihood   severity_level not null default 'medium',
  category     text,
  mitigation   text,
  owner_id     uuid references profiles(id),
  status       risk_status not null default 'open',
  raised_at    date not null default current_date,
  due_date     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on risks(project_id);
create trigger trg_risks_updated before update on risks
  for each row execute function nopm_set_updated_at();

create table issues (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  title        text not null,
  description  text,
  priority     priority_level not null default 'medium',
  resolution   text,
  owner_id     uuid references profiles(id),
  status       issue_status not null default 'open',
  raised_at    date not null default current_date,
  due_date     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on issues(project_id);
create trigger trg_issues_updated before update on issues
  for each row execute function nopm_set_updated_at();

-- Clash = a conflict where two projects (or a project + a resource) compete
-- for the same window/resource/dependency. Resource over-allocation surfaces here.
create table clashes (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  title              text not null,
  type               clash_type not null default 'schedule',
  severity           severity_level not null default 'medium',
  project_a_id       uuid references projects(id) on delete cascade,
  project_b_id       uuid references projects(id) on delete cascade,
  resource_member_id uuid references resource_members(id) on delete set null,
  window_start       date,
  window_end         date,
  status             clash_status not null default 'open',
  owner_id           uuid references profiles(id),
  resolution         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on clashes(workspace_id);
create trigger trg_clashes_updated before update on clashes
  for each row execute function nopm_set_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['risks','issues','clashes']
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

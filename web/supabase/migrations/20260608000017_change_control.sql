-- NoPM · 0017 change_control — change request register + decision log.
-- Governance: maker-checker CHECK on change_requests (decider ≠ requester for terminal statuses).

-- ── change_requests ────────────────────────────────────────────────────────

create table change_requests (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  project_id           uuid references projects(id) on delete cascade,
  reference_id         text,
  title                text not null,
  description          text,
  category             text not null default 'scope',
  priority             text not null default 'medium',
  status               text not null default 'raised',
  impact_summary       text,
  impact_schedule_days int,
  impact_cost          numeric(14,2),
  requested_by         uuid references profiles(id),
  requested_by_label   text,
  decided_by           uuid references profiles(id),
  decided_by_label     text,
  decision_rationale   text,
  raised_at            timestamptz not null default now(),
  decided_at           timestamptz,
  target_date          date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Four-eyes: any terminal status requires a decider that differs from the requester.
  constraint cr_maker_checker check (
    status in ('raised', 'under_review')
    or (decided_by is not null and decided_by <> requested_by)
  )
);

create index on change_requests(workspace_id, status);
create index on change_requests(project_id);

create trigger trg_change_requests_updated before update on change_requests
  for each row execute function nopm_set_updated_at();

-- ── decisions ──────────────────────────────────────────────────────────────

create table decisions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  project_id       uuid references projects(id) on delete cascade,
  reference_id     text,
  title            text not null,
  context          text,
  options          text,
  decision         text,
  rationale        text,
  status           text not null default 'accepted',
  decided_by       uuid references profiles(id),
  decided_by_label text,
  decided_at       timestamptz,
  supersedes       uuid references decisions(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index on decisions(workspace_id, status);
create index on decisions(project_id);

create trigger trg_decisions_updated before update on decisions
  for each row execute function nopm_set_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['change_requests', 'decisions']
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

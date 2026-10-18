-- NoPM · 0012 schedule depth — task dependencies, checklist, clash enrichment.

-- ── 1. task_dependencies ──────────────────────────────────────────────────────
-- Models FS / SS / FF / SF dependency relationships between tasks.
-- workspace_id is denormalised for RLS; both task FKs cascade on task delete.

create table task_dependencies (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  predecessor_id uuid not null references tasks(id) on delete cascade,
  successor_id   uuid not null references tasks(id) on delete cascade,
  type           text not null default 'FS'
                   check (type in ('FS', 'SS', 'FF', 'SF')),
  lag_days       int  not null default 0,
  created_at     timestamptz default now(),
  unique (predecessor_id, successor_id)
);
create index on task_dependencies(workspace_id);
create index on task_dependencies(predecessor_id);
create index on task_dependencies(successor_id);

-- ── 2. tasks.checklist ───────────────────────────────────────────────────────
-- Lightweight ordered checklist stored as a JSONB array of
-- {id, label, done, done_at?} objects. Default is an empty array.

alter table tasks
  add column checklist jsonb not null default '[]'::jsonb;

-- ── 3. clashes enrichment ────────────────────────────────────────────────────
-- Adds human-readable detail + AI-suggested remediation + over-allocation pct.

alter table clashes
  add column description          text,
  add column recommended_action   text,
  add column over_allocation_pct  numeric(6,2);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- task_dependencies follows the same workspace-scoped pattern as all other
-- tables: viewers may read; non-viewers may write.

alter table task_dependencies enable row level security;

create policy "read_task_dependencies" on task_dependencies
  for select using (workspace_id = nopm_current_workspace());

create policy "write_task_dependencies" on task_dependencies
  for all
  using  (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer')
  with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer');

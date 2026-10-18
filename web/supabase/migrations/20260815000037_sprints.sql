-- NoPM · 0037 sprints — first-class sprint/iteration entity with a governed
-- commitment snapshot (L-17/L-18).
--
-- A sprint is a fixed time-boxed container under a project. Tasks are
-- attached via tasks.sprint_id (nullable — a task's sprint membership is
-- optional and orthogonal to its milestone). The sprint's own lifecycle is a
-- three-state machine (planned -> active -> closed) driven exclusively by
-- POST /api/sprints/{id}/start and POST /api/sprints/{id}/close — plain PATCH
-- never changes `state` (see the API layer's own guard).
--
-- Commitment snapshot (the governance payload L-17/18 exists for): on start,
-- committed_points/committed_snapshot capture exactly what was attached at
-- that moment; on close, completed_points/completed_snapshot capture what
-- had reached status_type='completed' by then. Both snapshots are written
-- ONCE at the matching transition and NEVER recomputed afterwards — a later
-- edit to a task's story_points must not rewrite sprint history (unit-tested
-- at the API layer). committed_snapshot / completed_snapshot are
-- `{ "<task_id>": <points> }` maps, so a per-task contribution is always
-- recoverable even after a task is detached or its points change.
--
-- Overlapping active sprints on the same project are explicitly ALLOWED at
-- the DB layer (no exclusion constraint) — the owner-locked decision (D8,
-- f2b-specs.md) is to flag this in the UI, never block it here.
create table sprints (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  project_id         uuid not null references projects(id) on delete cascade,
  name               text not null check (char_length(trim(name)) > 0 and char_length(name) <= 120),
  goal               text,
  start_date         date not null,
  end_date           date not null,
  state              text not null default 'planned' check (state in ('planned', 'active', 'closed')),
  committed_points   numeric(8, 1),
  committed_snapshot jsonb,
  completed_points   numeric(8, 1),
  completed_snapshot jsonb,
  started_at         timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint sprints_end_on_or_after_start check (end_date >= start_date)
);

create index on sprints(workspace_id);
create index on sprints(project_id);

create trigger trg_sprints_updated before update on sprints
  for each row execute function nopm_set_updated_at();

-- A task belongs to 0..1 sprint. ON DELETE SET NULL — deleting a sprint never
-- deletes or orphans its attached tasks; they simply lose the sprint
-- grouping, mirroring projects.program_id's precedent (migration 0034).
alter table tasks add column sprint_id uuid references sprints(id) on delete set null;
create index on tasks(sprint_id);

-- ── RLS: house pair (workspace-scoped; viewers read-only, others read+write)
-- Mirrors programs' pattern (migration 0034) exactly.
alter table sprints enable row level security;

create policy "read sprints"  on sprints for select using (workspace_id = nopm_current_workspace());
create policy "write sprints" on sprints for all
  using (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer')
  with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer');

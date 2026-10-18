-- NoPM · 0099 project_dependencies (R-147, audit item B5).
-- A project can declare that it depends on another project (delivery, resource,
-- decision or risk). The portfolio uses the edge to flag a green project that is
-- contingent on a red one. The declared RAG of a project is never touched: the
-- flag is a suggestion, never a decision.
-- Additive: one new table, no dependency rows are created. The only update to existing data is
-- the re-snapshot of PENDING project deletion requests at the end (see the comment there).

create table if not exists project_dependencies (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references workspaces(id) on delete cascade,
  project_id             uuid not null references projects(id) on delete cascade,
  depends_on_project_id  uuid not null references projects(id) on delete cascade,
  kind                   text not null
                           check (kind in ('delivery', 'resource', 'decision', 'risk')),
  linked_risk_id         uuid references risks(id) on delete set null,
  note                   text,
  created_by             uuid references profiles(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint project_dependencies_unique unique (project_id, depends_on_project_id, kind),
  constraint project_dependencies_not_self check (project_id <> depends_on_project_id)
);

create index if not exists project_dependencies_workspace_idx on project_dependencies (workspace_id);
create index if not exists project_dependencies_project_idx on project_dependencies (project_id);
create index if not exists project_dependencies_depends_on_idx on project_dependencies (depends_on_project_id);
create index if not exists project_dependencies_risk_idx
  on project_dependencies (linked_risk_id) where linked_risk_id is not null;

comment on table project_dependencies is 'Project A depends on project B. kind = delivery | resource | decision | risk. Declared RAG is never changed by an edge.';
comment on column project_dependencies.linked_risk_id is 'Optional risk that records why the dependency matters; null when the risk is deleted.';

-- ── Same-workspace backstop (also covers the optional linked risk) ───────────
-- The API checks this first; the trigger keeps a service-role caller honest.
create or replace function nopm_project_dependency_same_workspace() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from projects p where p.id = new.project_id and p.workspace_id = new.workspace_id)
     or not exists (select 1 from projects p where p.id = new.depends_on_project_id and p.workspace_id = new.workspace_id) then
    raise exception 'CROSS_WORKSPACE' using detail = 'both projects must belong to the dependency workspace';
  end if;
  if new.linked_risk_id is not null
     and not exists (select 1 from risks r where r.id = new.linked_risk_id and r.workspace_id = new.workspace_id) then
    raise exception 'CROSS_WORKSPACE' using detail = 'the linked risk must belong to the dependency workspace';
  end if;
  return new;
end $$;

revoke execute on function nopm_project_dependency_same_workspace() from public, anon, authenticated;
grant  execute on function nopm_project_dependency_same_workspace() to service_role;

drop trigger if exists trg_project_dependencies_workspace on project_dependencies;
create trigger trg_project_dependencies_workspace
  before insert or update of workspace_id, project_id, depends_on_project_id, linked_risk_id on project_dependencies
  for each row execute function nopm_project_dependency_same_workspace();

-- ── Cycle guard (A -> B -> A is refused), the project-level twin of the task guard ──
-- An edge X -> Y closes a loop when Y can already reach X through existing edges.
-- Every kind counts: a loop of any mix of kinds has no valid order of work.
-- UNION (not UNION ALL) makes the walk terminate even if bad data already holds a loop.
-- The advisory lock serialises two concurrent inserts in one workspace, so two edges
-- that are each fine alone cannot both land and close a loop together.
create or replace function nopm_project_dependency_cycle_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('project_dependencies:' || new.workspace_id::text, 0));
  if exists (
    with recursive reach(project_id) as (
      select new.depends_on_project_id
      union
      select d.depends_on_project_id
        from project_dependencies d
        join reach r on d.project_id = r.project_id
       where d.workspace_id = new.workspace_id
         and d.id is distinct from new.id
    )
    select 1 from reach where project_id = new.project_id
  ) then
    raise exception 'DEPENDENCY_CYCLE' using detail = 'this dependency would create a circular reference between projects';
  end if;
  return new;
end $$;

revoke execute on function nopm_project_dependency_cycle_guard() from public, anon, authenticated;
grant  execute on function nopm_project_dependency_cycle_guard() to service_role;

drop trigger if exists trg_project_dependencies_cycle on project_dependencies;
create trigger trg_project_dependencies_cycle
  before insert or update of project_id, depends_on_project_id on project_dependencies
  for each row execute function nopm_project_dependency_cycle_guard();

-- ── updated_at ────────────────────────────────────────────────────────────────
drop trigger if exists trg_project_dependencies_updated on project_dependencies;
create trigger trg_project_dependencies_updated
  before update on project_dependencies
  for each row execute function nopm_set_updated_at();

-- ── RLS: read-only for browser roles; the API (service role) is the only writer ──
alter table project_dependencies enable row level security;

drop policy if exists "read_project_dependencies" on project_dependencies;
create policy "read_project_dependencies" on project_dependencies
  for select using (workspace_id = nopm_current_workspace());

revoke insert, update, delete on project_dependencies from anon, authenticated;

-- ── Project-deletion scope guard (0049/0054/0056): count the new cascade children ──
-- project_dependencies cascades from BOTH of its projects, so a deletion removes edges
-- where the project is on either side. project_snapshots (0098) also cascades from its project
-- but is DELIBERATELY NOT counted: it is derived system data regenerated nightly, so counting it
-- would make every pending project deletion fail approval (CHILDREN_CHANGED) after the next run.
-- nopm_project_child_counts must count every table that cascades from projects, or an
-- approved project deletion destroys their rows unannounced (lifecycle-guards-migration.test.ts).
-- Same function as 0056 plus project_dependencies; signature, attributes and grants unchanged.
create or replace function nopm_project_child_counts(p_project_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return jsonb_build_object(
    'milestones',      (select count(*) from milestones      where project_id = p_project_id),
    'tasks',           (select count(*) from tasks           where project_id = p_project_id),
    'risks',           (select count(*) from risks           where project_id = p_project_id),
    'issues',          (select count(*) from issues          where project_id = p_project_id),
    'change_requests', (select count(*) from change_requests where project_id = p_project_id),
    'decisions',       (select count(*) from decisions       where project_id = p_project_id),
    'rebaselines',     (select count(*) from rebaselines     where project_id = p_project_id),
    'time_entries',    (select count(*) from time_entries    where project_id = p_project_id),
    'documents',       (select count(*) from documents       where project_id = p_project_id),
    'expenses',        (select count(*) from expenses        where project_id = p_project_id),
    'allocations',     (select count(*) from allocations     where project_id = p_project_id),
    'sprints',         (select count(*) from sprints         where project_id = p_project_id),
    'project_budget',  (select count(*) from project_budget  where project_id = p_project_id),
    'calendar_feeds',  (select count(*) from calendar_feeds  where project_id = p_project_id),
    'clashes',         (select count(*) from clashes         where project_a_id = p_project_id or project_b_id = p_project_id),
    -- 0099: tables that cascade from projects since 0056.
    'project_dependencies', (select count(*) from project_dependencies where project_id = p_project_id or depends_on_project_id = p_project_id),
    -- 0056: the content fingerprint. Counts alone miss delete-one-add-one and
    -- any edit of the project itself. Reserved key; never a table name.
    '_scope',
    jsonb_build_object(
      'project',
      (select md5((to_jsonb(p) - 'completion_pct' - 'rag_status' - 'updated_at')::text)
         from projects p where p.id = p_project_id),
      'ids',
      jsonb_build_object(
      'milestones',      (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from milestones where project_id = p_project_id),
      'tasks',           (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from tasks where project_id = p_project_id),
      'risks',           (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from risks where project_id = p_project_id),
      'issues',          (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from issues where project_id = p_project_id),
      'change_requests', (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from change_requests where project_id = p_project_id),
      'decisions',       (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from decisions where project_id = p_project_id),
      'rebaselines',     (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from rebaselines where project_id = p_project_id),
      'time_entries',    (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from time_entries where project_id = p_project_id),
      'documents',       (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from documents where project_id = p_project_id),
      'expenses',        (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from expenses where project_id = p_project_id),
      'allocations',     (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from allocations where project_id = p_project_id),
      'sprints',         (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from sprints where project_id = p_project_id),
      'project_budget',  (select md5(coalesce(string_agg(project_id::text, ',' order by project_id), '')) from project_budget where project_id = p_project_id),
      'calendar_feeds',  (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from calendar_feeds where project_id = p_project_id),
      'clashes',         (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from clashes where project_a_id = p_project_id or project_b_id = p_project_id),
      'project_dependencies', (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from project_dependencies where project_id = p_project_id or depends_on_project_id = p_project_id)
      )
    )
  );
end;
$$;

revoke execute on function nopm_project_child_counts(uuid) from public, anon, authenticated;
grant  execute on function nopm_project_child_counts(uuid) to service_role;

-- A pending project deletion holds the snapshot taken before this migration, whose fingerprint
-- lacks the two new tables: the trigger would then refuse it as CHILDREN_CHANGED although nothing
-- changed. Re-snapshot those requests exactly as 0056 did (jsonb || overwrites the key).
update deletion_requests dr
   set before = coalesce(dr.before, '{}'::jsonb)
                || jsonb_build_object('child_counts', nopm_project_child_counts(dr.target_id))
 where dr.target_type = 'project'
   and dr.status = 'pending';

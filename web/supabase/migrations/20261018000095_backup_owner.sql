-- NoPM · 0095 backup_owner (2026-10-18, audit gap M6, CR-2026-10-18-01).
--
-- "Runs without you": every project, risk, issue and task can name a second person
-- who can pick it up. The handover report lists the open items whose single owner
-- has no backup, and the people who are a single point of failure.
--
-- Identity model (matches the primary column on each table):
--   projects.backup_owner_id, risks.backup_owner_id, issues.backup_owner_id
--       -> profiles(id), the same target as their owner_id.
--   tasks.backup_assignee_id -> resource_members(id), the same target as
--       tasks.assignee_id since 0019 (a task is assigned to a costed resource
--       member, who bridges to a login through resource_members.profile_id).
--
-- Additive only: nullable columns, no backfill (an unset backup is the finding
-- the report exists to show), no trigger touched, so no updated_at moves.
-- The "backup differs from the primary" CHECKs are added NOT VALID, then validated
-- in a block that skips with a NOTICE, so one odd row can never block a release.
--
-- ROLLBACK: alter table <t> drop constraint <t>_backup_differs; drop the index;
-- alter table <t> drop column <col>. Nothing else reads these columns.

alter table projects add column if not exists backup_owner_id    uuid references profiles(id)         on delete set null;
alter table risks    add column if not exists backup_owner_id    uuid references profiles(id)         on delete set null;
alter table issues   add column if not exists backup_owner_id    uuid references profiles(id)         on delete set null;
alter table tasks    add column if not exists backup_assignee_id uuid references resource_members(id) on delete set null;

create index if not exists idx_projects_backup_owner on projects (backup_owner_id)    where backup_owner_id is not null;
create index if not exists idx_risks_backup_owner    on risks    (backup_owner_id)    where backup_owner_id is not null;
create index if not exists idx_issues_backup_owner   on issues   (backup_owner_id)    where backup_owner_id is not null;
create index if not exists idx_tasks_backup_assignee on tasks    (backup_assignee_id) where backup_assignee_id is not null;

-- A backup who is the primary is no backup. NULL on either side passes.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'projects_backup_differs') then
    alter table projects add constraint projects_backup_differs
      check (backup_owner_id is null or owner_id is null or backup_owner_id <> owner_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'risks_backup_differs') then
    alter table risks add constraint risks_backup_differs
      check (backup_owner_id is null or owner_id is null or backup_owner_id <> owner_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'issues_backup_differs') then
    alter table issues add constraint issues_backup_differs
      check (backup_owner_id is null or owner_id is null or backup_owner_id <> owner_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_backup_differs') then
    alter table tasks add constraint tasks_backup_differs
      check (backup_assignee_id is null or assignee_id is null or backup_assignee_id <> assignee_id) not valid;
  end if;
end $$;

do $$ begin
  begin alter table projects validate constraint projects_backup_differs;
  exception when others then raise notice '0095: projects_backup_differs not validated (%)', sqlerrm; end;
  begin alter table risks validate constraint risks_backup_differs;
  exception when others then raise notice '0095: risks_backup_differs not validated (%)', sqlerrm; end;
  begin alter table issues validate constraint issues_backup_differs;
  exception when others then raise notice '0095: issues_backup_differs not validated (%)', sqlerrm; end;
  begin alter table tasks validate constraint tasks_backup_differs;
  exception when others then raise notice '0095: tasks_backup_differs not validated (%)', sqlerrm; end;
end $$;

comment on column projects.backup_owner_id    is 'Second person who can run this project if owner_id is away (M6, handover report).';
comment on column risks.backup_owner_id       is 'Second person who can pick up this risk if owner_id is away (M6).';
comment on column issues.backup_owner_id      is 'Second person who can pick up this issue if owner_id is away (M6).';
comment on column tasks.backup_assignee_id    is 'Second resource member who can pick up this task if assignee_id is away (M6).';

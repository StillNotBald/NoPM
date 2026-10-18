-- NoPM · 0114 (2026-10-18) — the database refuses a direct DELETE on programs, sprints, resource_members,
-- allocations and clashes (M1 close-out, W5-G, audit gap G8, R-176). POST-DEPLOY: apply only AFTER the build that
-- raises deletion requests for these five is live (PR-19).
--
-- WHY A SEPARATE FILE. The build that is live while 0113 is applied still deletes these five tables directly
-- (its DELETE routes call the audited delete). A refusing trigger attached at that moment would make every
-- one of those routes fail with P0040 until the new build is serving. So 0113 (commit RPCs, entity map, CHECK,
-- the flag in the task commit) goes first, the build is deployed, and only then this file closes the door.
-- Between 0113 and 0114 both the old and the new build keep working.
--
-- WHAT. nopm_refuse_direct_delete() (0102) is attached as a BEFORE DELETE ... FOR EACH ROW trigger to the five
-- tables. It raises P0040 DELETE_NEEDS_REQUEST unless the transaction-local setting nopm.deletion_commit is 'on'.
-- Only the commit RPCs set it: nopm_commit_{program,sprint,resource,allocation,clash}_deletion, and the commits
-- whose delete cascades into these tables (task, project; see the list in 0113). A service-role DELETE with no
-- approved request is refused. A workspace purge runs under session_replication_role = replica, which does not
-- fire these triggers (a deliberate, visible act; see the 0102 header).
--
-- GUARD. This file REFUSES TO RUN (raises) when 0113 is not applied, or when a cascading commit RPC does not set
-- the flag: attaching the trigger without them would break approvals of task and project deletions.
--
-- BEHAVIOUR ON EXISTING ROWS. No row is read, changed or deleted. Existing rows stay exactly as they are.
-- ROLLBACK (run by hand).
--   drop trigger if exists trg_programs_delete_needs_request on programs;
--   drop trigger if exists trg_sprints_delete_needs_request on sprints;
--   drop trigger if exists trg_resource_members_delete_needs_request on resource_members;
--   drop trigger if exists trg_allocations_delete_needs_request on allocations;
--   drop trigger if exists trg_clashes_delete_needs_request on clashes;
-- ORDER OF APPLY. After 0113 AND after the build is live.

do $$
declare
  fn text;
  src text;
begin
  if to_regprocedure('nopm_refuse_direct_delete()') is null then
    raise exception '0114: nopm_refuse_direct_delete() is missing (0102 not applied)';
  end if;
  foreach fn in array array[
    'nopm_commit_task_deletion', 'nopm_commit_project_deletion', 'nopm_commit_program_deletion',
    'nopm_commit_sprint_deletion', 'nopm_commit_resource_deletion', 'nopm_commit_allocation_deletion',
    'nopm_commit_clash_deletion'
  ] loop
    select p.prosrc into src from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn
     order by p.oid desc limit 1;
    if src is null then
      raise exception '0114: % is missing: apply 0113 first', fn;
    end if;
    if position('nopm.deletion_commit' in src) = 0 then
      raise exception '0114: % does not set nopm.deletion_commit: apply 0113 first', fn;
    end if;
  end loop;
end $$;

drop trigger if exists trg_programs_delete_needs_request on programs;
create trigger trg_programs_delete_needs_request
  before delete on programs
  for each row execute function nopm_refuse_direct_delete();

drop trigger if exists trg_sprints_delete_needs_request on sprints;
create trigger trg_sprints_delete_needs_request
  before delete on sprints
  for each row execute function nopm_refuse_direct_delete();

drop trigger if exists trg_resource_members_delete_needs_request on resource_members;
create trigger trg_resource_members_delete_needs_request
  before delete on resource_members
  for each row execute function nopm_refuse_direct_delete();

drop trigger if exists trg_allocations_delete_needs_request on allocations;
create trigger trg_allocations_delete_needs_request
  before delete on allocations
  for each row execute function nopm_refuse_direct_delete();

drop trigger if exists trg_clashes_delete_needs_request on clashes;
create trigger trg_clashes_delete_needs_request
  before delete on clashes
  for each row execute function nopm_refuse_direct_delete();

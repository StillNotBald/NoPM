-- NoPM · 0061 (2026-10-17) — deletion approval is for admins and managers only.
--
-- OWNER DECISION D-16 ("follow Lark rules", 2026-10-17): approving or deciding
-- is for admins and managers on EVERY channel. The API layer refuses a member
-- or viewer (403 role_not_permitted) before it reaches the database; this
-- migration repeats the rule in the database as a backstop, so a code path that
-- skips the application guard still cannot commit or reject a deletion for a
-- non-approver.
--
-- WHY A TRIGGER, NOT A CHANGE TO THE COMMIT RPCs. The deletion commit RPCs
-- (nopm_commit_task_deletion / nopm_commit_project_deletion) are redefined by
-- several migrations; a role check inside their bodies would be silently lost
-- by the next redefinition. A trigger on deletion_requests survives them, and it
-- also covers the direct reject update. It fires inside the RPC's transaction,
-- so a refused approver rolls the whole commit back (nothing deleted or audited).
--
-- WHAT. BEFORE UPDATE trigger on deletion_requests: when status moves from
-- 'pending' to 'committed', 'approved' or 'rejected', the approved_principal_id
-- (the HUMAN behind the decider) must be an admin or manager profile of the same
-- workspace, else P0018 ROLE_NOT_PERMITTED. A NULL principal is left to the
-- existing NO_PRINCIPAL guards. 'withdrawn' (maker verb) is not an approval.
-- decide.ts maps P0018 to 403 role_not_permitted.
--
-- BACKWARD COMPATIBLE for admins and managers. ROLLBACK: drop the trigger and function.

create or replace function nopm_deletion_approver_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status::text = 'pending'
     and new.status::text in ('committed', 'approved', 'rejected')
     and new.approved_principal_id is not null then
    if not exists (
      select 1 from profiles
       where id = new.approved_principal_id
         and workspace_id = new.workspace_id
         and role in ('admin', 'manager')
    ) then
      raise exception 'ROLE_NOT_PERMITTED: only managers and admins can approve' using errcode = 'P0018';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_deletion_approver_role() from public, anon, authenticated;
grant  execute on function nopm_deletion_approver_role() to service_role;

drop trigger if exists trg_deletion_approver_role on deletion_requests;
create trigger trg_deletion_approver_role
  before update on deletion_requests
  for each row execute function nopm_deletion_approver_role();

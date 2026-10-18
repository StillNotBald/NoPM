-- NoPM · 0073 (2026-10-17) — timesheet approve/reject is for admins and managers
-- only, enforced in the database too (R-9; owner decision D-16).
--
-- Same shape as 0061 (deletion requests): a BEFORE UPDATE trigger on
-- timesheet_submissions. When a submitted sheet moves to 'approved' or 'rejected'
-- and decided_principal_id (the HUMAN behind the decider) is set, that profile
-- must be an admin or manager of the same workspace, else P0018
-- ROLE_NOT_PERMITTED. Submit (insert), the requester's own withdraw, and reopen
-- (approved -> submitted) are not approvals and are untouched. A NULL principal
-- (legacy token) is left to the application guard, as in 0061.
-- ROLLBACK: drop trigger trg_timesheet_approver_role on timesheet_submissions;
--           drop function nopm_timesheet_approver_role();

create or replace function nopm_timesheet_approver_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status::text = 'submitted'
     and new.status::text in ('approved', 'rejected')
     and new.decided_principal_id is not null then
    if not exists (
      select 1 from profiles
       where id = new.decided_principal_id
         and workspace_id = new.workspace_id
         and role in ('admin', 'manager')
    ) then
      raise exception 'ROLE_NOT_PERMITTED: only managers and admins can approve' using errcode = 'P0018';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_timesheet_approver_role() from public, anon, authenticated;
grant  execute on function nopm_timesheet_approver_role() to service_role;

drop trigger if exists trg_timesheet_approver_role on timesheet_submissions;
create trigger trg_timesheet_approver_role
  before update on timesheet_submissions
  for each row execute function nopm_timesheet_approver_role();

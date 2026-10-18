-- NoPM · lark wave rollout · OPTIONAL ROLLBACK OF 0049  (WRITES: removes five triggers, replaces one function)
--
-- What it does: removes the five lifecycle triggers added by migration 0049 (locked-project dates,
-- submitted-week freeze updates, timesheet approval binding, rebaseline lifecycle, project-delete
-- scope) and restores the 0040 body of nopm_assert_week_unlocked() (lines 30-66 of
-- 20260815000040_time_period_lock.sql). The new columns and helper functions stay (unused, harmless).
-- This WEAKENS governance. Use it only if the PREVIOUS build has to run against the migrated schema
-- and its timesheet reopen or rebaseline sign-off must behave as before.
-- When to run: after an app rollback, never as part of a normal rollout. To go back, re-run the trigger
-- statements of 20261017000049_lifecycle_guards.sql.

begin;
drop trigger if exists trg_lock_backstop_projects_upd on projects;
drop trigger if exists trg_period_lock_time_entries_upd on time_entries;
drop trigger if exists trg_timesheet_approval_binds_content on timesheet_submissions;
drop trigger if exists trg_rebaseline_lifecycle on rebaselines;
drop trigger if exists trg_project_delete_scope on projects;
create or replace function nopm_assert_week_unlocked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_member_id uuid;
  v_entry_date date;
  v_locked boolean;
begin
  if tg_op = 'DELETE' then
    v_member_id := old.member_id;
    v_entry_date := old.entry_date;
  else
    v_member_id := new.member_id;
    v_entry_date := new.entry_date;
  end if;

  select exists (
    select 1
    from timesheet_submissions
    where member_id = v_member_id
      and status = 'approved'
      and v_entry_date between period_start and period_end
  ) into v_locked;

  if v_locked then
    raise exception 'PERIOD_LOCKED: this week''s timesheet is approved and locked — reopen the submission before changing time entries'
      using errcode = 'P0011';
  end if;

  return coalesce(new, old);
end;
$$;

revoke execute on function nopm_assert_week_unlocked() from public, anon, authenticated;
grant  execute on function nopm_assert_week_unlocked() to service_role;
commit;

-- NoPM · 0040 — period-close lock DB backstop (L-32 -> R-76, triplicate
-- lock enforcement: UI marker (week-grid.tsx) + route guard
-- (lib/governance/period-lock.ts, time-entries POST/DELETE) + this trigger).
--
-- SEMANTICS: a member's week is LOCKED once an APPROVED timesheet_submission
-- covers it (period_start..period_end, the same Monday-first 7-day window
-- ts_period_is_one_week enforces, migration 0038). While locked, time_entries
-- for that member+week reject BOTH create and delete — there is no update
-- route on time_entries (recon-time.md §2: create/delete only), so those are
-- the only two write shapes that need guarding. Unlock happens only via the
-- governed "reopened" decision verb (POST /timesheet-submissions/{id}/
-- decision), which reverts the submission to 'submitted' and therefore drops
-- it out of this trigger's WHERE status = 'approved' check.
--
-- NO BYPASS GUC — unlike the project-lock backstop (migration 0028), this
-- trigger has no nopm.lock_bypass-style escape hatch and none should be
-- added: the only legitimate way to change locked-week entries is to reopen
-- the submission first, which is itself an audited, four-eyes-guarded write.
-- There is no "apply this schedule change to a locked week" analogue to
-- rebaseline apply that would ever need one.
--
-- SEEDING NOTE (read this before writing T2's seed script): this trigger
-- fires on time_entries INSERT/DELETE, not on timesheet_submissions writes,
-- so seeding an approved submission is safe — but the ORDER matters. Time
-- entries for a week MUST be created BEFORE that week's submission is
-- marked 'approved'. Once approved, inserting or deleting entries in that
-- window is rejected until the submission is reopened. Seed entries first,
-- decide (approve) second.

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

-- Postgres forbids referencing NEW in a pure DELETE trigger and OLD in a pure
-- INSERT trigger, so — same idiom as migration 0028 — INSERT and DELETE each
-- get their own CREATE TRIGGER rather than one combined "INSERT OR DELETE".
-- There is no UPDATE trigger: time_entries has no update route (create/
-- delete only, recon-time.md §2).

drop trigger if exists trg_period_lock_time_entries_ins on time_entries;
create trigger trg_period_lock_time_entries_ins
  before insert on time_entries
  for each row execute function nopm_assert_week_unlocked();

drop trigger if exists trg_period_lock_time_entries_del on time_entries;
create trigger trg_period_lock_time_entries_del
  before delete on time_entries
  for each row execute function nopm_assert_week_unlocked();

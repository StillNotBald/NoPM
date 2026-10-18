-- Owner decision 18 (2026-10-17): hour logging was removed from the product;
-- time_entries / timesheet_submissions and their rows are KEPT as an archive.
-- Nothing can reopen or decide a week any more, so the week lock must no
-- longer block DELETE: otherwise approving a project / task deletion (or any
-- cascade) fails forever once archived hours sit in an approved or submitted
-- week. INSERT / UPDATE behaviour is unchanged (nothing writes hours now).
-- Same name, so the existing INSERT / UPDATE / DELETE triggers keep pointing
-- at it. Body copied from 0049; ONLY the DELETE branch changed. Attributes
-- (not security definer, search_path) and grants identical to 0049.
-- No data change, no dropped table or trigger.
-- ROLLBACK: re-run the nopm_assert_week_unlocked() body from 20261017000049.

create or replace function nopm_assert_week_unlocked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_state text;
begin
  if tg_op = 'DELETE' then
    -- Decision 18: archived hours may be deleted (cascade from project / task).
    return old;
  elsif tg_op = 'INSERT' then
    v_state := nopm_week_lock_state(new.member_id, new.entry_date);
  else
    -- UPDATE: the row leaves its old week and enters its new one; both must be open.
    v_state := nopm_week_lock_state(old.member_id, old.entry_date);
    if v_state is null then
      v_state := nopm_week_lock_state(new.member_id, new.entry_date);
    end if;
  end if;

  if v_state = 'approved' then
    raise exception 'PERIOD_LOCKED: this week''s timesheet is approved and locked — reopen the submission before changing time entries'
      using errcode = 'P0011';
  elsif v_state = 'under_review' then
    raise exception 'TIMESHEET_LOCKED: this week''s timesheet is submitted and awaiting a decision, so its time entries are frozen until it is decided'
      using errcode = 'P0012';
  end if;

  return new;
end;
$$;

revoke execute on function nopm_assert_week_unlocked() from public, anon, authenticated;
grant  execute on function nopm_assert_week_unlocked() to service_role;

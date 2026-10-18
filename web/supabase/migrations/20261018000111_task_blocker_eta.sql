-- NoPM · 0111 task blocker reason and ETA (2026-10-18, wave 5 W5-D, R-166).
--
-- WHAT THIS ADDS (additive; nothing is dropped or rewritten; safe on the live rows at ledger 0106+).
--   tasks.blocker_reason  text, nullable, no default, at most 500 characters. Why the task is blocked,
--                         in words. It is independent of tasks.blocked_by: a reason without a blocking
--                         task and a blocking task without a reason are both allowed.
--   tasks.eta             date, nullable, no default. When the owner now expects the work to finish. It is a
--                         forecast, not the baseline, so a date in the past is allowed and it is not a
--                         schedule-shape field (it stays editable on a locked project, like blocked_by).
--
-- BEHAVIOUR ON EXISTING ROWS. Every existing task gets NULL in both columns. There is no backfill, no new
-- required field and no trigger. The 500-character CHECK is added NOT VALID and then validated; no existing
-- row can violate it because the column is new, and if validation ever fails the migration RAISES.
--
-- ROLLBACK (run by hand, only if nothing has written the columns yet):
--   alter table tasks drop constraint if exists tasks_blocker_reason_len;
--   alter table tasks drop column if exists blocker_reason;
--   alter table tasks drop column if exists eta;

alter table tasks add column if not exists blocker_reason text;
alter table tasks add column if not exists eta date;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_blocker_reason_len' and conrelid = 'public.tasks'::regclass
  ) then
    alter table tasks
      add constraint tasks_blocker_reason_len
      check (blocker_reason is null or char_length(blocker_reason) <= 500) not valid;
  end if;
end $$;

do $$
begin
  alter table tasks validate constraint tasks_blocker_reason_len;
exception when others then
  raise exception '0111: tasks_blocker_reason_len could not be validated (%)', sqlerrm;
end $$;

comment on column tasks.blocker_reason is 'R-166: optional free-text reason the task is blocked (max 500 characters). Independent of blocked_by.';
comment on column tasks.eta is 'R-166: optional forecast finish date. Not the baseline; may be in the past; not a schedule-shape field.';

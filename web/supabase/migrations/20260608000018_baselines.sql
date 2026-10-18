-- NoPM · 0018 baselines — capture the approved plan dates on milestones and tasks.
-- baseline_* columns are set ONCE (on project lock) and updated only when a
-- rebaseline is applied.  A null value means "not yet baselined" — render nothing.
-- Variance / slip = current date minus baseline date.

alter table milestones
  add column if not exists baseline_target_date date;

alter table tasks
  add column if not exists baseline_start_date date,
  add column if not exists baseline_due_date   date;

-- NoPM · 0031 — guard the project-completion rollup trigger (0021) so an
-- UPDATE that touches none of the columns the rollup formula reads no longer
-- fires a full recompute.
--
-- nopm_recompute_project_completion() (0021) computes a project's
-- completion_pct as the estimate_hours-weighted average of its non-cancelled
-- tasks, reading exactly three task columns: status_type, completion_pct,
-- and estimate_hours (`case when t.status_type = 'completed' then 100 else
-- coalesce(t.completion_pct, 0) end`, weighted by
-- `case when t.estimate_hours is not null and t.estimate_hours > 0 then
-- t.estimate_hours else 1 end`) — plus project_id, which decides *which*
-- project's rollup a row belongs to.
--
-- Before this migration, trg_tasks_completion_rollup fired
-- `after insert or update or delete on tasks for each row` unconditionally,
-- so an UPDATE that only touched e.g. name/description/priority/sort_order
-- still recomputed the whole project's completion (a scan + aggregate over
-- every task in the project) on every keystroke-driven autosave. This
-- migration replaces that one trigger with three, per NoPM's INSERT/DELETE-
-- trigger-can't-reference-OLD/NEW-of-the-other-op constraint (same pattern
-- as 0028's lock-backstop triggers):
--   * trg_tasks_completion_rollup_ins — AFTER INSERT, unconditional (a new
--     task always changes the weighted average).
--   * trg_tasks_completion_rollup_del — AFTER DELETE, unconditional (ditto,
--     removing one).
--   * trg_tasks_completion_rollup_upd — AFTER UPDATE, WHEN-guarded to only
--     the four columns above (status_type, completion_pct, estimate_hours,
--     project_id) — the exact set the formula reads, plus project_id for
--     cross-project moves.
--
-- Cross-project move (project_id changes) stays covered: the underlying
-- function nopm_tasks_completion_rollup() (0021, UNCHANGED by this
-- migration — no CREATE OR REPLACE needed) already recomputes BOTH sides —
-- `perform nopm_recompute_project_completion(new.project_id)` unconditionally,
-- then `if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id
-- then perform nopm_recompute_project_completion(old.project_id); end if` —
-- and project_id is included in this migration's WHEN clause, so that branch
-- still fires exactly as before. Only the *unconditional* firing on
-- irrelevant-column updates is removed.

drop trigger if exists trg_tasks_completion_rollup on tasks;

create trigger trg_tasks_completion_rollup_ins
  after insert on tasks
  for each row execute function nopm_tasks_completion_rollup();

create trigger trg_tasks_completion_rollup_del
  after delete on tasks
  for each row execute function nopm_tasks_completion_rollup();

create trigger trg_tasks_completion_rollup_upd
  after update on tasks
  for each row
  when (
    old.status_type is distinct from new.status_type
    or old.completion_pct is distinct from new.completion_pct
    or old.estimate_hours is distinct from new.estimate_hours
    or old.project_id is distinct from new.project_id
  )
  execute function nopm_tasks_completion_rollup();

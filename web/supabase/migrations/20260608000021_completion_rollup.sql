-- NoPM · 0021 project completion = weighted rollup of task completion.
--
-- Before: projects.completion_pct was a manually-entered field, and EVM's EV
-- (= BAC × completion_pct) was therefore only as honest as the PM's last manual
-- update. This makes completion DERIVED from the work: a project's % is the
-- estimate-hours-weighted average of its non-cancelled tasks' completion (a
-- completed task counts 100; others use their own completion_pct). Maintained by
-- a trigger so every reader (dashboard, EVM, reports) sees a number grounded in
-- reality. Backfilled on apply.

create or replace function nopm_recompute_project_completion(p_project_id uuid)
returns void language plpgsql as $$
begin
  update projects p set completion_pct = coalesce((
    select round(sum(w * pct)::numeric / nullif(sum(w), 0))
    from (
      select
        case when t.estimate_hours is not null and t.estimate_hours > 0 then t.estimate_hours else 1 end as w,
        case when t.status_type = 'completed' then 100 else coalesce(t.completion_pct, 0) end as pct
      from tasks t
      where t.project_id = p_project_id and t.status_type <> 'canceled'
    ) s
  ), 0)
  where p.id = p_project_id;
end $$;

create or replace function nopm_tasks_completion_rollup()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform nopm_recompute_project_completion(old.project_id);
    return old;
  end if;
  perform nopm_recompute_project_completion(new.project_id);
  -- a task moved between projects: refresh the old project too
  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    perform nopm_recompute_project_completion(old.project_id);
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_completion_rollup on tasks;
create trigger trg_tasks_completion_rollup
  after insert or update or delete on tasks
  for each row execute function nopm_tasks_completion_rollup();

-- Backfill every existing project from its current tasks.
do $$
declare pid uuid;
begin
  for pid in select id from projects loop
    perform nopm_recompute_project_completion(pid);
  end loop;
end $$;

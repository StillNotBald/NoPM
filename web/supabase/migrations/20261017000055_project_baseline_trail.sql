-- NoPM · 0055 project_baseline_trail (2026-10-17) — applying a rebaseline now moves
-- the PROJECT's own baseline dates, not just its milestones' and tasks'.
--
-- WHY. Owner decision 2026-10-17 ("yes, and with a trail"): an approved
-- rebaseline makes the newly approved plan the new baseline. 0028's
-- nopm_apply_rebaseline_snapshot() copied the current milestone and task dates
-- into their baseline_* columns but never touched projects.baseline_start_date /
-- projects.baseline_target_date, so after an apply the project row still carried
-- the OLD baseline while every child carried the new one (the Gantt's project
-- variance read against a stale plan). The columns are frozen for a locked
-- project by the 0049 trigger (P0010), and the same transaction-local bypass
-- that already lets the snapshot rewrite the children lets it rewrite this row.
--
-- WHAT. Same function, same signature and return type, same attributes, same
-- grants — it only gains one more UPDATE inside the existing bypass:
--   projects.baseline_start_date  := start_date
--   projects.baseline_target_date := target_date
-- for that project, when at least one of the two dates is set. That is the rule
-- the task snapshot already follows (a row with no dates at all is left alone,
-- so an apply can never wipe a baseline to null). The audit trail lives in the
-- apply route: it reads the project's baseline before and after this call and
-- records both in the rebaseline.apply audit row (after.project_baseline).
--
-- BACKWARD COMPATIBLE. Nothing about the call changes (still
-- nopm_apply_rebaseline_snapshot(uuid, uuid) returns void), so the build that is
-- live today keeps working against this function: it simply gets the extra
-- project baseline write. No table, column, policy, trigger or grant is added.
--
-- ROLLBACK. Re-create the function with the 0028 body (the two UPDATEs on
-- milestones and tasks, without the projects UPDATE below). Nothing else
-- depends on this migration; baselines already written stay as they are.
--
-- Nothing here inserts into audit_log and no function that does is redefined,
-- so the RPC provenance and glossary drift tests are unaffected.

create or replace function nopm_apply_rebaseline_snapshot(
  p_project_id   uuid,
  p_workspace_id uuid
) returns void
  language plpgsql
  set search_path = public
as $$
begin
  perform set_config('nopm.lock_bypass', 'on', true);

  update milestones
    set baseline_target_date = target_date
    where project_id = p_project_id
      and workspace_id = p_workspace_id
      and target_date is not null;

  update tasks
    set baseline_start_date = start_date,
        baseline_due_date   = due_date
    where project_id = p_project_id
      and workspace_id = p_workspace_id
      and (start_date is not null or due_date is not null);

  -- 0055: the project's own baseline follows the plan that was just approved.
  update projects
    set baseline_start_date  = start_date,
        baseline_target_date = target_date
    where id = p_project_id
      and workspace_id = p_workspace_id
      and (start_date is not null or target_date is not null);
end;
$$;

revoke execute on function nopm_apply_rebaseline_snapshot(uuid, uuid) from public, anon, authenticated;
grant  execute on function nopm_apply_rebaseline_snapshot(uuid, uuid) to service_role;

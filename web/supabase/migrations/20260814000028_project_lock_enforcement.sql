-- NoPM · 0028 — project-lock DB backstop (devops-wave1a T2, triplicate lock
-- enforcement: UI copy + API guard (lock.ts / T1) + this DB trigger).
--
-- SEMANTICS — "schedule frozen, work continues": locking a project
-- (projects.is_locked) freezes its *schedule shape* — task/milestone dates,
-- baseline dates, estimate_hours, and which milestone/project a task belongs
-- to, plus the task_dependencies graph — while day-to-day work (status,
-- checklist, assignee, priority, completion_pct, ...) stays fully live. This
-- mirrors web/src/lib/governance/lock.ts's SCHEDULE_SHAPE_TASK_FIELDS /
-- SCHEDULE_SHAPE_MILESTONE_FIELDS exactly, column for column.
--
-- This migration is the DB-level backstop for that rule: even if a future
-- code path (a new route, a script, a direct psql session under the
-- service role) forgets to call assertProjectUnlocked(), these triggers
-- still reject the write. Enforcement is unconditional on INSERT/DELETE
-- (a locked project's schedule shape cannot gain or lose rows) and
-- conditional on UPDATE (only when a schedule-shape column actually
-- changes — status/checklist/etc. edits pass through untouched).
--
-- BYPASS CONTRACT — nopm.lock_bypass: enforcement is skipped for the
-- current transaction when `current_setting('nopm.lock_bypass', true) =
-- 'on'`. This is a deliberately narrow, transaction-local escape hatch
-- (set via `set_config('nopm.lock_bypass', 'on', true)` — the `true` third
-- arg makes it local to the calling transaction, auto-reset on commit/
-- rollback) for the ONE legitimate reason a locked project's dates change:
-- applying an approved rebaseline. See nopm_apply_rebaseline_snapshot()
-- below, called by POST /api/rebaselines/[id]/apply. No other code path
-- sets this GUC. Notably, nopm_commit_task_deletion() (migration 0020,
-- four-eyes task-delete commit) deliberately does NOT get a bypass — a
-- pending deletion against a task whose project gets locked before it is
-- approved must fail loudly (PROJECT_LOCKED, errcode P0010), not commit
-- silently. The approve route maps that error to a 422 RuleError.

-- ── 1. Trigger function ──────────────────────────────────────────────────
-- One function, attached to tasks / milestones / task_dependencies, that
-- resolves the relevant project id(s) per table via TG_TABLE_NAME/TG_OP and
-- raises PROJECT_LOCKED (errcode P0010) if any of them is locked.

-- Small helper (not a trigger): raises PROJECT_LOCKED / P0010 iff the given
-- project exists and is_locked. Null-safe (a resolved project id can be null
-- — e.g. a task_dependencies row pointing at a task deleted earlier in the
-- same statement's cascade — in which case there is nothing left to check).
-- Defined before nopm_assert_project_unlocked() so it exists when that
-- trigger function is first invoked.
create or replace function nopm_reject_if_project_locked(p_project_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_locked boolean;
begin
  if p_project_id is null then
    return;
  end if;
  select is_locked into v_locked from projects where id = p_project_id;
  if v_locked then
    raise exception 'PROJECT_LOCKED: project schedule is frozen — unlock the project or apply a rebaseline before making this change'
      using errcode = 'P0010';
  end if;
end;
$$;

create or replace function nopm_assert_project_unlocked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_pred_project uuid;
  v_succ_project uuid;
begin
  -- Bypass: transaction-local, set only by nopm_apply_rebaseline_snapshot().
  if current_setting('nopm.lock_bypass', true) = 'on' then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'tasks' then
    if tg_op = 'DELETE' then
      perform nopm_reject_if_project_locked(old.project_id);
      return old;
    elsif tg_op = 'INSERT' then
      perform nopm_reject_if_project_locked(new.project_id);
      return new;
    else -- UPDATE (WHEN clause on the trigger already limits this to schedule-shape changes)
      perform nopm_reject_if_project_locked(old.project_id);
      -- Cross-project move: the destination project's schedule shape is
      -- gaining a task, so it must be checked too.
      if new.project_id is distinct from old.project_id then
        perform nopm_reject_if_project_locked(new.project_id);
      end if;
      return new;
    end if;

  elsif tg_table_name = 'milestones' then
    if tg_op = 'DELETE' then
      perform nopm_reject_if_project_locked(old.project_id);
      return old;
    elsif tg_op = 'INSERT' then
      perform nopm_reject_if_project_locked(new.project_id);
      return new;
    else -- UPDATE
      perform nopm_reject_if_project_locked(old.project_id);
      return new;
    end if;

  elsif tg_table_name = 'task_dependencies' then
    -- task_dependencies has no project_id column of its own (denormalised
    -- only with workspace_id) — resolve via the successor/predecessor tasks.
    if tg_op = 'DELETE' then
      select project_id into v_succ_project from tasks where id = old.successor_id;
      perform nopm_reject_if_project_locked(v_succ_project);
      select project_id into v_pred_project from tasks where id = old.predecessor_id;
      if v_pred_project is distinct from v_succ_project then
        perform nopm_reject_if_project_locked(v_pred_project);
      end if;
      return old;
    else -- INSERT
      select project_id into v_succ_project from tasks where id = new.successor_id;
      perform nopm_reject_if_project_locked(v_succ_project);
      select project_id into v_pred_project from tasks where id = new.predecessor_id;
      if v_pred_project is distinct from v_succ_project then
        perform nopm_reject_if_project_locked(v_pred_project);
      end if;
      return new;
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

revoke execute on function nopm_assert_project_unlocked() from public, anon, authenticated;
grant  execute on function nopm_assert_project_unlocked() to service_role;
revoke execute on function nopm_reject_if_project_locked(uuid) from public, anon, authenticated;
grant  execute on function nopm_reject_if_project_locked(uuid) to service_role;

-- ── 2. Triggers — tasks ──────────────────────────────────────────────────
-- Postgres forbids referencing OLD in a pure INSERT trigger and NEW in a
-- pure DELETE trigger, so INSERT/DELETE/UPDATE each get their own
-- CREATE TRIGGER (the WHEN clause, which needs both OLD and NEW, only
-- applies to the UPDATE one).

drop trigger if exists trg_lock_backstop_tasks_ins on tasks;
create trigger trg_lock_backstop_tasks_ins
  before insert on tasks
  for each row execute function nopm_assert_project_unlocked();

drop trigger if exists trg_lock_backstop_tasks_del on tasks;
create trigger trg_lock_backstop_tasks_del
  before delete on tasks
  for each row execute function nopm_assert_project_unlocked();

drop trigger if exists trg_lock_backstop_tasks_upd on tasks;
create trigger trg_lock_backstop_tasks_upd
  before update on tasks
  for each row
  when (
    old.start_date is distinct from new.start_date
    or old.due_date is distinct from new.due_date
    or old.baseline_start_date is distinct from new.baseline_start_date
    or old.baseline_due_date is distinct from new.baseline_due_date
    or old.estimate_hours is distinct from new.estimate_hours
    or old.milestone_id is distinct from new.milestone_id
    or old.project_id is distinct from new.project_id
  )
  execute function nopm_assert_project_unlocked();

-- ── 3. Triggers — milestones ─────────────────────────────────────────────

drop trigger if exists trg_lock_backstop_milestones_ins on milestones;
create trigger trg_lock_backstop_milestones_ins
  before insert on milestones
  for each row execute function nopm_assert_project_unlocked();

drop trigger if exists trg_lock_backstop_milestones_del on milestones;
create trigger trg_lock_backstop_milestones_del
  before delete on milestones
  for each row execute function nopm_assert_project_unlocked();

drop trigger if exists trg_lock_backstop_milestones_upd on milestones;
create trigger trg_lock_backstop_milestones_upd
  before update on milestones
  for each row
  when (
    old.start_date is distinct from new.start_date
    or old.target_date is distinct from new.target_date
    or old.baseline_target_date is distinct from new.baseline_target_date
  )
  execute function nopm_assert_project_unlocked();

-- ── 4. Triggers — task_dependencies ──────────────────────────────────────
-- INSERT/DELETE only (adding/removing an edge reshapes the schedule graph;
-- task_dependencies rows are never updated in place by the app).

drop trigger if exists trg_lock_backstop_task_deps_ins on task_dependencies;
create trigger trg_lock_backstop_task_deps_ins
  before insert on task_dependencies
  for each row execute function nopm_assert_project_unlocked();

drop trigger if exists trg_lock_backstop_task_deps_del on task_dependencies;
create trigger trg_lock_backstop_task_deps_del
  before delete on task_dependencies
  for each row execute function nopm_assert_project_unlocked();

-- ── 5. Legitimate bypass path — rebaseline apply ─────────────────────────
-- The apply route (web/src/app/api/rebaselines/[id]/apply/route.ts) is the
-- one legitimate place a locked project's dates change: applying an
-- approved rebaseline snapshots the current schedule as the new baseline.
-- Prior to this migration that snapshot was written as N separate
-- supabase-js `.update()` calls in the route — each its own PostgREST
-- request/transaction, so a transaction-local set_config() on the TS side
-- could never have covered all of them. This migration moves that snapshot
-- into a single SQL function (same logic, faithfully ported: for every
-- milestone with a non-null target_date, baseline_target_date :=
-- target_date; for every task with a non-null start_date or due_date,
-- baseline_start_date := start_date and baseline_due_date := due_date) so
-- the whole operation — and the set_config('nopm.lock_bypass', 'on', true)
-- bypass at its start — runs in the one transaction the RPC call opens. The
-- route is updated in this same wave to call this RPC instead of looping.

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
end;
$$;

revoke execute on function nopm_apply_rebaseline_snapshot(uuid, uuid) from public, anon, authenticated;
grant  execute on function nopm_apply_rebaseline_snapshot(uuid, uuid) to service_role;

-- NOTE: nopm_commit_task_deletion (migration 0020) is intentionally left
-- unmodified — no bypass is added there. A locked project's task delete
-- must keep failing with PROJECT_LOCKED; see web/src/app/api/
-- deletion-requests/[id]/approve/route.ts's error-mapping block (updated in
-- this same wave to map errcode P0010 to a 422 RuleError).

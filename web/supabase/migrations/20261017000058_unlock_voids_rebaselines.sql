-- NoPM · 0058 unlock_voids_rebaselines (2026-10-17) — unlocking a project cancels
-- its pending and approved rebaselines.
--
-- OWNER DECISION (2026-10-17, R-95): "Unlocking a project cancels its pending and
-- approved rebaselines. Unlock itself stays a single-person act." (project:write
-- + a required reason; R-83 unchanged.)
--
-- WHY. nopm_apply_rebaseline_snapshot() copies the LIVE dates at apply time. So
-- one person could unlock a locked project, edit its start / target / baseline
-- dates, lock it again, and an already-approved rebaseline would then be applied
-- on dates its approvers never saw. Voiding the open rebaselines on unlock forces
-- a fresh proposal and a fresh sign-off after any edit.
--
-- WHAT.
--   1. rebaseline_status gains the terminal value 'cancelled'.
--   2. The 0049 state machine (nopm_enforce_rebaseline_lifecycle) allows
--        pending_approval -> cancelled   and   approved -> cancelled
--      and nothing leaves 'cancelled'. A draft is NOT cancelled: it carries no
--      sign-off (the project was unlocked when it was proposed), so there is
--      nothing stale to void; it can never be signed off or applied anyway.
--   3. nopm_unlock_project(project, workspace) does the unlock AND the
--      cancellation in ONE transaction, so an unlock can never stand while an
--      approved rebaseline survives it. It returns { project, cancelled } where
--      cancelled lists { id, version, previous_status } so the route can audit
--      each one. SECURITY DEFINER, pinned search_path, service_role only.
--      The route (not SQL) writes the audit rows, like every other mutation.
--
-- ORDER OF APPLY. Apply this migration BEFORE deploying the build that calls
-- nopm_unlock_project (the new unlock route fails closed with a 500 if the
-- function does not exist: it never unlocks without cancelling).
-- BACKWARD COMPATIBLE with the previous build: it only adds an enum value, widens
-- a trigger allow-list and adds a function; the previous unlock route still
-- works (it simply does not cancel) and nothing it reads or writes changes.
-- ROLLBACK. drop function nopm_unlock_project(uuid, uuid); restore the 0049 body
--           of nopm_enforce_rebaseline_lifecycle(). (A Postgres enum value cannot
--           be dropped; an unused 'cancelled' is harmless.)
--
-- NOTE. 'cancelled' is added here but not used by any statement that runs in this
-- migration's transaction (Postgres refuses to use a new enum value before the
-- transaction that added it commits): the function bodies below are plpgsql,
-- which resolves the literal at run time.

alter type rebaseline_status add value if not exists 'cancelled';

create or replace function nopm_enforce_rebaseline_lifecycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (old.status = 'draft'            and new.status = 'pending_approval')
  or (old.status = 'pending_approval' and new.status in ('approved', 'rejected', 'cancelled'))
  or (old.status = 'approved'         and new.status in ('applied', 'cancelled')) then
    return new;
  end if;
  raise exception 'REBASELINE_TRANSITION: a % rebaseline cannot become %', old.status, new.status
    using errcode = 'P0014';
end;
$$;

revoke execute on function nopm_enforce_rebaseline_lifecycle() from public, anon, authenticated;
grant  execute on function nopm_enforce_rebaseline_lifecycle() to service_role;

create or replace function nopm_unlock_project(p_project_id uuid, p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project   projects%rowtype;
  v_cancelled jsonb;
begin
  -- Serialise against a concurrent lock / unlock of the same project.
  perform 1 from projects where id = p_project_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'NOT_FOUND: project not found' using errcode = 'P0002';
  end if;

  -- Void every open rebaseline first. The row locks held by `prev` make a
  -- concurrent sign-off / apply wait, then fail its status compare-and-set.
  with prev as (
    select id, status
      from rebaselines
     where project_id   = p_project_id
       and workspace_id = p_workspace_id
       and status in ('pending_approval', 'approved')
       for update
  ), upd as (
    update rebaselines r
       set status = 'cancelled'
      from prev
     where r.id = prev.id
    returning r.id, r.version, prev.status as previous_status
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object('id', upd.id, 'version', upd.version, 'previous_status', upd.previous_status)
             order by upd.version
           ),
           '[]'::jsonb)
    into v_cancelled
    from upd;

  update projects
     set is_locked = false,
         locked_by = null,
         locked_at = null,
         lock_reason = null
   where id = p_project_id
     and workspace_id = p_workspace_id
  returning * into v_project;

  return jsonb_build_object('project', to_jsonb(v_project), 'cancelled', v_cancelled);
end;
$$;

revoke execute on function nopm_unlock_project(uuid, uuid) from public, anon, authenticated;
grant  execute on function nopm_unlock_project(uuid, uuid) to service_role;

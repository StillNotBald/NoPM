-- NoPM · 0049 lifecycle_guards (2026-10-17) — database backstops for the governed
-- lifecycles that the red-team round (R1) showed were enforced by the API alone.
--
-- Every finding below had the same shape: the route refused the bad move, but
-- nothing in the database did, so a new route, a script or a direct service-role
-- session could still make it. Each guard here repeats an API rule in the
-- database (same errcode family as 0028 / 0040 / 0045).
--
--   H1  a LOCKED project's schedule dates and baselines cannot be rewritten        (P0010)
--   H2  a timesheet week under review (submitted) or approved is frozen; an
--       approval must match the entries it was submitted with                     (P0011 / P0012 / P0013)
--   M2  rebaselines follow draft -> pending_approval -> approved -> applied, or
--       pending_approval -> rejected; rejected and applied are terminal           (P0014)
--   M4  a project deletion cannot commit if the project gained records after the
--       request was raised                                                        (P0016)
--
-- ERRCODES (mapped to HTTP 422 by the API):
--   P0010 PROJECT_LOCKED       (existing, 0028/0032)
--   P0011 PERIOD_LOCKED        (existing, 0040)  the week's sheet is APPROVED
--   P0012 TIMESHEET_LOCKED     (new)             the week's sheet is SUBMITTED, under review
--   P0013 TIMESHEET_CHANGED    (new)             approval vs. entries that no longer match
--   P0014 REBASELINE_TRANSITION (new)            illegal rebaseline status change
--   P0016 CHILDREN_CHANGED     (new)             project gained children since the request
--   (P0015 is intentionally unused: reserved for decided change-request edits, which are
--    enforced in the API layer only.)
--
-- Nothing here inserts into audit_log and no existing function that does is
-- redefined, so the RPC provenance and glossary drift tests are unaffected.

-- ═══ 1. H1 — a locked project's dates and baselines are frozen ═══════════════
--
-- 0028 froze tasks, milestones and dependencies but never the project ROW, so
-- one holder of project:write could rewrite a locked project's baseline with a
-- plain PATCH — no rebaseline, no four-eyes — and leave only a "project.update"
-- audit row. This is the DB half of the fix (the PATCH route is the other).
--
-- Only a project that is ALREADY locked is frozen: locking it (is_locked
-- false -> true) is the act that freezes, and unlocking (true -> false) is the
-- governed release, neither of which changes these columns. The same
-- transaction-local bypass as 0028 applies (nopm.lock_bypass, set only by
-- nopm_apply_rebaseline_snapshot()).

create or replace function nopm_assert_project_baseline_unlocked()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('nopm.lock_bypass', true) = 'on' then
    return new;
  end if;
  raise exception 'PROJECT_LOCKED: project baseline is frozen — unlock the project or apply a rebaseline before changing its dates'
    using errcode = 'P0010';
end;
$$;

revoke execute on function nopm_assert_project_baseline_unlocked() from public, anon, authenticated;
grant  execute on function nopm_assert_project_baseline_unlocked() to service_role;

drop trigger if exists trg_lock_backstop_projects_upd on projects;
create trigger trg_lock_backstop_projects_upd
  before update on projects
  for each row
  when (
    old.is_locked is true
    and (
      old.start_date is distinct from new.start_date
      or old.target_date is distinct from new.target_date
      or old.baseline_start_date is distinct from new.baseline_start_date
      or old.baseline_target_date is distinct from new.baseline_target_date
    )
  )
  execute function nopm_assert_project_baseline_unlocked();

-- ═══ 2. H2 — timesheet approval is bound to what was reviewed ════════════════
--
-- 0040 locked a week only once its sheet was APPROVED, and hours_total /
-- entry_count were a snapshot nobody compared again. So entries added after
-- "submitted" were approved unseen, and an approver could reopen a sheet, edit
-- the member's hours themselves and re-approve against the stale snapshot.
--
-- Two guards now stack:
--   FREEZE  a week whose sheet is SUBMITTED (under review) is frozen exactly
--           like an approved one — except a sheet that was REOPENED
--           (reopened_at set), because reopening is the governed unlock verb
--           and the edits it exists for are bound at the next approval instead;
--   BIND    approving a sheet requires the live entries to still match the
--           snapshot taken at submit time (hours and entry count here; the API
--           additionally compares a content digest, which catches a swap of one
--           8h entry for another that totals cannot).
-- Rejecting a sheet unfreezes the week; the member edits and resubmits a fresh
-- row with a fresh snapshot.

alter table timesheet_submissions
  add column if not exists content_digest text,
  add column if not exists reopened_at    timestamptz;

comment on column timesheet_submissions.content_digest is
  'SHA-256 of the time entries (id, day, hours, project, billable) as submitted; the API refuses approval (422 timesheet_changed) unless the live entries still match. NULL on rows submitted before 0049: those fall back to the hours/entry_count snapshot.';
comment on column timesheet_submissions.reopened_at is
  'set when an approved sheet is reopened (governed unlock): while status = submitted AND reopened_at is set the week''s entries may be edited; otherwise a submitted sheet freezes its week.';

-- 'approved' | 'under_review' | NULL for a member's day.
create or replace function nopm_week_lock_state(p_member_id uuid, p_entry_date date)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when bool_or(status = 'approved') then 'approved'
    when bool_or(status = 'submitted' and reopened_at is null) then 'under_review'
    else null
  end
  from timesheet_submissions
  where member_id = p_member_id
    and status in ('submitted', 'approved')
    and p_entry_date between period_start and period_end
$$;

revoke execute on function nopm_week_lock_state(uuid, date) from public, anon, authenticated;
grant  execute on function nopm_week_lock_state(uuid, date) to service_role;

-- Replaces the 0040 body (same name, so the existing INSERT / DELETE triggers
-- keep pointing at it). Still NO bypass GUC: the only way to change a frozen
-- week is the governed decision (reject, or reopen an approved sheet).
create or replace function nopm_assert_week_unlocked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_state text;
begin
  if tg_op = 'DELETE' then
    v_state := nopm_week_lock_state(old.member_id, old.entry_date);
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

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_assert_week_unlocked() from public, anon, authenticated;
grant  execute on function nopm_assert_week_unlocked() to service_role;

-- 0040 guarded INSERT and DELETE only ("no update route"). A direct write could
-- still move an entry or change its hours, so UPDATE is guarded too — but only
-- when a content column changes: deleting a task nulls time_entries.task_id (an
-- FK action, i.e. an UPDATE) and must not be blocked by a locked week.
drop trigger if exists trg_period_lock_time_entries_upd on time_entries;
create trigger trg_period_lock_time_entries_upd
  before update on time_entries
  for each row
  when (
    old.member_id  is distinct from new.member_id
    or old.entry_date is distinct from new.entry_date
    or old.hours      is distinct from new.hours
    or old.project_id is distinct from new.project_id
    or old.billable   is distinct from new.billable
  )
  execute function nopm_assert_week_unlocked();

create or replace function nopm_assert_timesheet_unchanged()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_hours numeric;
  v_count int;
begin
  select coalesce(sum(hours), 0), count(*) into v_hours, v_count
    from time_entries
    where member_id = new.member_id
      and entry_date between new.period_start and new.period_end;

  if v_hours <> new.hours_total or v_count <> new.entry_count then
    raise exception 'TIMESHEET_CHANGED: the time entries changed after this timesheet was submitted — reject it so the member can resubmit'
      using errcode = 'P0013';
  end if;
  return new;
end;
$$;

revoke execute on function nopm_assert_timesheet_unchanged() from public, anon, authenticated;
grant  execute on function nopm_assert_timesheet_unchanged() to service_role;

drop trigger if exists trg_timesheet_approval_binds_content on timesheet_submissions;
create trigger trg_timesheet_approval_binds_content
  before update on timesheet_submissions
  for each row
  when (new.status = 'approved' and old.status is distinct from 'approved')
  execute function nopm_assert_timesheet_unchanged();

-- ═══ 3. M2 — rebaseline status is a state machine, not a recomputation ═══════
--
-- The sign-off route recomputed status from the votes on every call, with no
-- regard for where the rebaseline already was: a rejected one could be revived
-- by flipping no_go to go, an applied one regressed to approved after any later
-- vote and could be applied (re-snapshotting the baselines) again.
--
--   draft ─► pending_approval ─► approved ─► applied      (terminal)
--                       └──────► rejected                 (terminal)
--
-- Mirrors src/lib/governance/rebaseline-lifecycle.ts. Applies to UPDATEs of the
-- status column only; inserts (a seed, a fresh proposal) are not transitions.

create or replace function nopm_enforce_rebaseline_lifecycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (old.status = 'draft'            and new.status = 'pending_approval')
  or (old.status = 'pending_approval' and new.status in ('approved', 'rejected'))
  or (old.status = 'approved'         and new.status = 'applied') then
    return new;
  end if;
  raise exception 'REBASELINE_TRANSITION: a % rebaseline cannot become %', old.status, new.status
    using errcode = 'P0014';
end;
$$;

revoke execute on function nopm_enforce_rebaseline_lifecycle() from public, anon, authenticated;
grant  execute on function nopm_enforce_rebaseline_lifecycle() to service_role;

drop trigger if exists trg_rebaseline_lifecycle on rebaselines;
create trigger trg_rebaseline_lifecycle
  before update on rebaselines
  for each row
  when (old.status is distinct from new.status)
  execute function nopm_enforce_rebaseline_lifecycle();

-- ═══ 4. M4 — a project deletion is bound to the scope that was requested ═════
--
-- Approving a project deletion cascades to everything under the project. The
-- request snapshotted the project ROW only, so a project that was empty when the
-- deletion was requested could gain tasks, risks, time entries... before the
-- approver acted, and the approval destroyed them without anyone being asked.
--
-- The request now records `before.child_counts` (this function's output). A
-- BEFORE DELETE trigger on projects compares the live counts to the ones on the
-- project's PENDING deletion request and refuses on any difference. It fires
-- inside the commit RPC's transaction (the request is still 'pending' and locked
-- FOR UPDATE at that point), so nothing can skip it and 0045's RPCs need no
-- redefinition. A project deleted with no pending request (a workspace
-- teardown) is untouched.

create or replace function nopm_project_child_counts(p_project_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return jsonb_build_object(
    'milestones',      (select count(*) from milestones      where project_id = p_project_id),
    'tasks',           (select count(*) from tasks           where project_id = p_project_id),
    'risks',           (select count(*) from risks           where project_id = p_project_id),
    'issues',          (select count(*) from issues          where project_id = p_project_id),
    'change_requests', (select count(*) from change_requests where project_id = p_project_id),
    'decisions',       (select count(*) from decisions       where project_id = p_project_id),
    'rebaselines',     (select count(*) from rebaselines     where project_id = p_project_id),
    'time_entries',    (select count(*) from time_entries    where project_id = p_project_id),
    'documents',       (select count(*) from documents       where project_id = p_project_id),
    'expenses',        (select count(*) from expenses        where project_id = p_project_id),
    'allocations',     (select count(*) from allocations     where project_id = p_project_id),
    'sprints',         (select count(*) from sprints         where project_id = p_project_id)
  );
end;
$$;

revoke execute on function nopm_project_child_counts(uuid) from public, anon, authenticated;
grant  execute on function nopm_project_child_counts(uuid) to service_role;

-- SECURITY DEFINER so the guard sees deletion_requests (and may call the count
-- function) whoever issues the DELETE; it only ever raises or returns OLD.
create or replace function nopm_assert_project_children_unchanged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected jsonb;
begin
  select dr.before -> 'child_counts' into v_expected
    from deletion_requests dr
    where dr.target_type = 'project'
      and dr.target_id = old.id
      and dr.status = 'pending'
    limit 1;

  if v_expected is not null and nopm_project_child_counts(old.id) is distinct from v_expected then
    raise exception 'CHILDREN_CHANGED: the project gained records after this deletion was requested — raise a new request so the approver sees the current scope'
      using errcode = 'P0016';
  end if;
  return old;
end;
$$;

revoke execute on function nopm_assert_project_children_unchanged() from public, anon, authenticated;
grant  execute on function nopm_assert_project_children_unchanged() to service_role;

drop trigger if exists trg_project_delete_scope on projects;
create trigger trg_project_delete_scope
  before delete on projects
  for each row execute function nopm_assert_project_children_unchanged();

-- Requests already waiting for approval when this migration runs have no
-- snapshot of their scope. Bind them to the project's contents as of now: any
-- later change makes the approval fail loudly instead of cascading silently.
update deletion_requests dr
   set before = coalesce(dr.before, '{}'::jsonb)
                || jsonb_build_object('child_counts', nopm_project_child_counts(dr.target_id))
 where dr.target_type = 'project'
   and dr.status = 'pending'
   and (dr.before is null or not (dr.before ? 'child_counts'));

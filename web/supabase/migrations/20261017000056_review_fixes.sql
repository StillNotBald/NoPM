-- NoPM · 0056 review_fixes (2026-10-17) — four defects from the 2026-10-17 review.
--
-- 1. REBASELINE APPLY NO LONGER WIPES A PROJECT BASELINE DATE.
--    0055 set projects.baseline_start_date / baseline_target_date from the live
--    start_date / target_date whenever EITHER live date was set. With start_date
--    set, target_date null and a baseline_target_date on record, that wrote NULL
--    over the baseline target — contradicting 0055's own promise that an apply
--    can never wipe a baseline to null. Each baseline column now moves only when
--    its OWN live date is non-null (coalesce per column).
--
-- 2. A TASK DELETION THAT DELETED NOTHING IS NOT COMMITTED.
--    nopm_commit_task_deletion did not look at how many rows `delete from tasks`
--    removed. If the task had already been cascade-deleted (its project was
--    deleted, say) the request still became 'committed' and a task.delete audit
--    row named the approver. Both commit RPCs now raise TARGET_GONE / P0017 when
--    the delete removed 0 rows. The raise rolls back the whole call, so no
--    request update and no audit row survive; decide.ts closes the stale request
--    (status 'withdrawn', no approver) and answers 422 target_gone.
--    P0017 was unused: P0001-P0006, P0010-P0014 and P0016 are taken, P0015 is
--    deliberately unused (0049).
--
-- 3. THE PROJECT-DELETION SCOPE GUARD COMPARES CONTENT, NOT ONLY COUNTS.
--    0049/0054 compared per-table row COUNTS, so delete-one-add-one, or a rename
--    or date change of the project itself, passed. nopm_project_child_counts()
--    still returns the same per-table counts (every key a number, so existing
--    readers are unaffected) and now ALSO returns a reserved key `_scope`:
--      _scope.project  md5 of the project row's own fields (completion_pct,
--                      rag_status and updated_at excluded: task progress rolls
--                      them up on its own and must not void an approval)
--      _scope.ids      per child table, md5 of its sorted ids
--    The trigger compares the whole object when the request's snapshot has
--    `_scope`, and the counts alone (legacy) when it does not. Requests raised
--    by a build that predates this migration store whatever the function
--    returns, so they pick up `_scope` automatically; requests pending when this
--    runs are re-snapshotted below (same compromise as 0049 / 0054).
--    The commit RPC and the trigger now lock the project row FOR UPDATE before
--    counting, closing the count-before-lock race.
--
-- 4. INDEX FOR THE SET-NULL FOREIGN KEY ON integration_deliveries.
--    parent_delivery_id references integration_deliveries(id) ON DELETE SET NULL;
--    the only index on it is partial (where kind = 'decision_update') and cannot
--    serve the FK's lookup, so deleting a delivery scanned the table.
--
-- BACKWARD COMPATIBLE. Every function keeps its name, signature, return type,
-- attributes and grants. The live build keeps working against 0056 (it ignores
-- P0017 and would surface it as a generic error until the new build is out;
-- count-only legacy snapshots are still honoured). Apply 0056 BEFORE or WITH the
-- new build; neither order breaks anything.
--
-- Re-running this file is safe: create or replace, create index if not exists,
-- and a re-snapshot that recomputes the same value for the same data.
-- Rollback: re-create the 0055 / 0054 / 0049 / 0045 bodies; drop the index.

-- == 1. rebaseline snapshot ===================================================

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

  -- 0056: each baseline column moves only when its own live date is set, so an
  -- apply can never overwrite a recorded baseline with null.
  update projects
    set baseline_start_date  = coalesce(start_date,  baseline_start_date),
        baseline_target_date = coalesce(target_date, baseline_target_date)
    where id = p_project_id
      and workspace_id = p_workspace_id
      and (start_date is not null or target_date is not null);
end;
$$;

revoke execute on function nopm_apply_rebaseline_snapshot(uuid, uuid) from public, anon, authenticated;
grant  execute on function nopm_apply_rebaseline_snapshot(uuid, uuid) to service_role;

-- == 2. deletion commit RPCs: nothing deleted = nothing committed =============

-- Defensive, as in 0045: neither pre-principal overload may exist. Both are no-ops
-- where 0045 already ran.
drop function if exists nopm_commit_task_deletion(uuid, uuid, text, uuid, text, text, text);

create or replace function nopm_commit_task_deletion(
  p_request_id           uuid,
  p_workspace_id         uuid,
  p_approver_type        text,
  p_approver_id          uuid,
  p_approver_label       text,
  p_approver_principal_id uuid,
  p_channel              text default null,
  p_correlation_id       text default null,
  p_note                 text default null,
  p_via_connector_id     uuid default null,
  p_external_event_id    text default null,
  p_external_actor_ref   text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r  deletion_requests%rowtype;
  ts timestamptz := now();
  v_note text := nullif(btrim(p_note), '');
  v_deleted integer;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;

  -- Fail-closed: a checker with no recorded human can never approve.
  if p_approver_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;

  -- Lock the request so concurrent approvals serialize on it.
  select * into r from deletion_requests
    where id = p_request_id and workspace_id = p_workspace_id
    for update;

  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception 'ALREADY_DECIDED' using errcode = 'P0001';
  end if;
  if r.requested_by_id = p_approver_id then
    raise exception 'SELF_APPROVAL' using errcode = 'P0003';
  end if;
  if r.requested_principal_id is not null and r.requested_principal_id = p_approver_principal_id then
    raise exception 'SELF_APPROVAL' using errcode = 'P0003';
  end if;

  -- 1. delete the target (only 'task' supported today)
  if r.target_type = 'task' then
    delete from tasks where id = r.target_id and workspace_id = p_workspace_id;
    -- 0056: a delete that removed nothing must not be committed or audited. The
    -- task can already be gone (a project deletion cascaded it, or another path
    -- removed it). Raising rolls the whole call back, so no task.delete row
    -- names this approver for something they did not delete; the caller closes
    -- the stale request (decide.ts, target_gone).
    get diagnostics v_deleted = row_count;
    if v_deleted = 0 then
      raise exception 'TARGET_GONE: the task no longer exists, so there is nothing to delete'
        using errcode = 'P0017';
    end if;
  end if;

  -- 2. commit the deletion request
  update deletion_requests set
    status                = 'committed',
    approved_by_type      = p_approver_type::actor_type,
    approved_by_id        = p_approver_id,
    approved_by_label     = p_approver_label,
    approved_principal_id = p_approver_principal_id,
    decided_at            = ts,
    committed_at          = ts
  where id = p_request_id and workspace_id = p_workspace_id;

  -- 3. audit the deletion (before = snapshot captured at request time)
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'task.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  -- 4. audit the governance step itself — records the HUMAN behind the
  --    approver and the approver's optional note.
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'deletion_request.approved', 'deletion_request', r.id,
            jsonb_build_object('status', 'pending'),
            jsonb_build_object('status', 'committed', 'approver_principal_id', p_approver_principal_id)
              || case when v_note is not null then jsonb_build_object('note', v_note) else '{}'::jsonb end,
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  return jsonb_build_object(
    'committed', true,
    'request_id', r.id,
    'requested_by_id', r.requested_by_id,
    'requested_principal_id', r.requested_principal_id,
    'target_type', r.target_type,
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- Defensive, as in 0045: neither pre-principal overload may exist. Both are no-ops
-- where 0045 already ran.
drop function if exists nopm_commit_project_deletion(uuid, uuid, text, uuid, text, text, text);

create or replace function nopm_commit_project_deletion(
  p_request_id           uuid,
  p_workspace_id         uuid,
  p_approver_type        text,
  p_approver_id          uuid,
  p_approver_label       text,
  p_approver_principal_id uuid,
  p_channel              text default null,
  p_correlation_id       text default null,
  p_note                 text default null,
  p_via_connector_id     uuid default null,
  p_external_event_id    text default null,
  p_external_actor_ref   text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r          deletion_requests%rowtype;
  ts         timestamptz := now();
  v_locked   boolean;
  v_note     text := nullif(btrim(p_note), '');
  v_deleted  integer;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;

  -- Fail-closed: a checker with no recorded human can never approve.
  if p_approver_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;

  -- Lock the request so concurrent approvals serialize on it.
  select * into r from deletion_requests
    where id = p_request_id and workspace_id = p_workspace_id
    for update;

  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception 'ALREADY_DECIDED' using errcode = 'P0001';
  end if;
  if r.requested_by_id = p_approver_id then
    raise exception 'SELF_APPROVAL' using errcode = 'P0003';
  end if;
  if r.requested_principal_id is not null and r.requested_principal_id = p_approver_principal_id then
    raise exception 'SELF_APPROVAL' using errcode = 'P0003';
  end if;

  -- A locked project's schedule shape is frozen (0028) — a cascaded child
  -- delete would trip that backstop mid-transaction anyway; fail cleanly and
  -- early instead of letting the cascade discover it.
  --
  -- 0056: the project row is locked FOR UPDATE here, BEFORE anything is counted.
  -- A child insert takes a key-share lock on its project, so once this line has
  -- run no insert can slip in between the scope check (the BEFORE DELETE
  -- trigger) and the cascade, and an insert already in flight is waited for.
  select is_locked into v_locked from projects
    where id = r.target_id and workspace_id = p_workspace_id
    for update;
  if v_locked then
    raise exception 'PROJECT_LOCKED: project schedule is frozen — unlock the project or apply a rebaseline before deleting it'
      using errcode = 'P0010';
  end if;

  -- 1. delete the target project (cascades milestones/tasks/risks/issues/
  --    clashes/budget/documents/change-control/rebaselines — all FK'd
  --    `on delete cascade` from projects(id)). No nopm.lock_bypass needed —
  --    see 0032 header note: the project row is confirmed unlocked above, and
  --    by the time cascaded child rows fire their own BEFORE DELETE triggers
  --    the parent project row is already gone, so 0028's null-safe lookup
  --    skips enforcement on its own.
  delete from projects where id = r.target_id and workspace_id = p_workspace_id;
  -- 0056: nothing deleted = nothing to commit or audit (project already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the project no longer exists, so there is nothing to delete'
      using errcode = 'P0017';
  end if;

  -- 2. commit the deletion request
  update deletion_requests set
    status                = 'committed',
    approved_by_type      = p_approver_type::actor_type,
    approved_by_id        = p_approver_id,
    approved_by_label     = p_approver_label,
    approved_principal_id = p_approver_principal_id,
    decided_at            = ts,
    committed_at          = ts
  where id = p_request_id and workspace_id = p_workspace_id;

  -- 3. audit the deletion (before = snapshot captured at request time)
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'project.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  -- 4. audit the governance step itself — records the HUMAN behind the
  --    approver and the approver's optional note.
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'deletion_request.approved', 'deletion_request', r.id,
            jsonb_build_object('status', 'pending'),
            jsonb_build_object('status', 'committed', 'approver_principal_id', p_approver_principal_id)
              || case when v_note is not null then jsonb_build_object('note', v_note) else '{}'::jsonb end,
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  return jsonb_build_object(
    'committed', true,
    'request_id', r.id,
    'requested_by_id', r.requested_by_id,
    'requested_principal_id', r.requested_principal_id,
    'target_type', r.target_type,
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == 3. project-deletion scope: content fingerprint + row lock ================

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
    'sprints',         (select count(*) from sprints         where project_id = p_project_id),
    'project_budget',  (select count(*) from project_budget  where project_id = p_project_id),
    'calendar_feeds',  (select count(*) from calendar_feeds  where project_id = p_project_id),
    'clashes',         (select count(*) from clashes         where project_a_id = p_project_id or project_b_id = p_project_id),
    -- 0056: the content fingerprint. Counts alone miss delete-one-add-one and
    -- any edit of the project itself. Reserved key; never a table name.
    '_scope',
    jsonb_build_object(
      'project',
      (select md5((to_jsonb(p) - 'completion_pct' - 'rag_status' - 'updated_at')::text)
         from projects p where p.id = p_project_id),
      'ids',
      jsonb_build_object(
      'milestones',      (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from milestones where project_id = p_project_id),
      'tasks',           (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from tasks where project_id = p_project_id),
      'risks',           (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from risks where project_id = p_project_id),
      'issues',          (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from issues where project_id = p_project_id),
      'change_requests', (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from change_requests where project_id = p_project_id),
      'decisions',       (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from decisions where project_id = p_project_id),
      'rebaselines',     (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from rebaselines where project_id = p_project_id),
      'time_entries',    (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from time_entries where project_id = p_project_id),
      'documents',       (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from documents where project_id = p_project_id),
      'expenses',        (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from expenses where project_id = p_project_id),
      'allocations',     (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from allocations where project_id = p_project_id),
      'sprints',         (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from sprints where project_id = p_project_id),
      'project_budget',  (select md5(coalesce(string_agg(project_id::text, ',' order by project_id), '')) from project_budget where project_id = p_project_id),
      'calendar_feeds',  (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from calendar_feeds where project_id = p_project_id),
      'clashes',         (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from clashes where project_a_id = p_project_id or project_b_id = p_project_id)
      )
    )
  );
end;
$$;

revoke execute on function nopm_project_child_counts(uuid) from public, anon, authenticated;
grant  execute on function nopm_project_child_counts(uuid) to service_role;

-- SECURITY DEFINER as in 0049: it must see deletion_requests whoever issues the
-- DELETE. It only ever raises or returns OLD.
create or replace function nopm_assert_project_children_unchanged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected jsonb;
  v_current  jsonb;
begin
  select dr.before -> 'child_counts' into v_expected
    from deletion_requests dr
    where dr.target_type = 'project'
      and dr.target_id = old.id
      and dr.status = 'pending'
    limit 1;

  if v_expected is null then
    return old;
  end if;

  -- 0056: lock the project row BEFORE counting. A child insert holds a key-share
  -- lock on its project, so a concurrent insert either committed before this
  -- line (and is counted) or waits until the delete is over.
  perform 1 from projects where id = old.id for update;

  v_current := nopm_project_child_counts(old.id);

  -- A snapshot that carries `_scope` is compared whole (counts + content). One
  -- taken before 0056 has none: compare the counts only, as 0049 did.
  if not (v_expected ? '_scope') then
    v_current := v_current - '_scope';
  end if;

  if v_current is distinct from v_expected then
    raise exception 'CHILDREN_CHANGED: the project or its records changed after this deletion was requested — raise a new request so the approver sees the current scope'
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

-- Requests waiting for approval hold a counts-only snapshot. Re-snapshot them
-- (jsonb || overwrites the key) so they gain the fingerprint instead of being
-- compared count-only forever. Bound to the project's contents as of now.
update deletion_requests dr
   set before = coalesce(dr.before, '{}'::jsonb)
                || jsonb_build_object('child_counts', nopm_project_child_counts(dr.target_id))
 where dr.target_type = 'project'
   and dr.status = 'pending';

-- == 4. plain index under the set-null FK =====================================

create index if not exists integration_deliveries_parent_delivery_idx
  on integration_deliveries (parent_delivery_id);

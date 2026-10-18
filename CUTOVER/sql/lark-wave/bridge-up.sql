-- NoPM · lark wave rollout · OPTIONAL BRIDGE, UP  (WRITES: creates two functions)
--
-- What it does: re-creates the two seven-argument deletion-commit functions of migration 0044
-- (nopm_commit_task_deletion, nopm_commit_project_deletion), copied verbatim from lines 52-125 and
-- 131-219 of 20260906000044_rpc_audit_provenance.sql. Migration 0045 drops them, which makes the
-- PREVIOUS build's deletion approvals fail until the new build is live. They coexist with 0045's
-- twelve-argument functions (Postgres and PostgREST pick by argument names and count), so nothing
-- about the new build changes.
-- Cost: the old functions check actor ids only, no principal check. That is exactly today's live
-- behaviour, for the length of the window.
-- When to run: only if the gap between the migration commit and the promote may be more than a few
-- seconds. Run it right after the migration, and run bridge-down.sql right after the promote.

create or replace function nopm_commit_task_deletion(
  p_request_id     uuid,
  p_workspace_id   uuid,
  p_approver_type  text,
  p_approver_id    uuid,
  p_approver_label text,
  p_channel        text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r  deletion_requests%rowtype;
  ts timestamptz := now();
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
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

  -- 1. delete the target (only 'task' supported today)
  if r.target_type = 'task' then
    delete from tasks where id = r.target_id and workspace_id = p_workspace_id;
  end if;

  -- 2. commit the deletion request
  update deletion_requests set
    status            = 'committed',
    approved_by_type  = p_approver_type::actor_type,
    approved_by_id    = p_approver_id,
    approved_by_label = p_approver_label,
    decided_at        = ts,
    committed_at      = ts
  where id = p_request_id and workspace_id = p_workspace_id;

  -- 3. audit the deletion (before = snapshot captured at request time)
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'task.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id);

  -- 4. audit the governance step itself
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'deletion_request.approved', 'deletion_request', r.id,
            jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'committed'),
            p_channel, p_correlation_id);

  return jsonb_build_object(
    'committed', true,
    'request_id', r.id,
    'requested_by_id', r.requested_by_id,
    'target_type', r.target_type,
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text, text, text) to service_role;

create or replace function nopm_commit_project_deletion(
  p_request_id     uuid,
  p_workspace_id   uuid,
  p_approver_type  text,
  p_approver_id    uuid,
  p_approver_label text,
  p_channel        text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r          deletion_requests%rowtype;
  ts         timestamptz := now();
  v_locked   boolean;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
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

  -- A locked project's schedule shape is frozen (0028) — a cascaded child
  -- delete would trip that backstop mid-transaction anyway; fail cleanly and
  -- early instead of letting the cascade discover it.
  select is_locked into v_locked from projects
    where id = r.target_id and workspace_id = p_workspace_id;
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

  -- 2. commit the deletion request
  update deletion_requests set
    status            = 'committed',
    approved_by_type  = p_approver_type::actor_type,
    approved_by_id    = p_approver_id,
    approved_by_label = p_approver_label,
    decided_at        = ts,
    committed_at      = ts
  where id = p_request_id and workspace_id = p_workspace_id;

  -- 3. audit the deletion (before = snapshot captured at request time)
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'project.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id);

  -- 4. audit the governance step itself
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'deletion_request.approved', 'deletion_request', r.id,
            jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'committed'),
            p_channel, p_correlation_id);

  return jsonb_build_object(
    'committed', true,
    'request_id', r.id,
    'requested_by_id', r.requested_by_id,
    'target_type', r.target_type,
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, text, text) to service_role;

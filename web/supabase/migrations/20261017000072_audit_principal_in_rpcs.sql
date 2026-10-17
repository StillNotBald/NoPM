-- NoPM · 0072 (2026-10-17) — SQL-written audit rows carry audit_log.principal_id (R-2).
--
-- WHY. 0071 added audit_log.principal_id and filled it from writeAudit, but the
-- RPCs added in 0062-0069 write their audit rows directly in SQL and left it
-- NULL, so the approvals, rebaseline applies, locks/unlocks, project deletions
-- and connector revokes (exactly the rows a Trust Center filter by person needs)
-- had no principal.
--
-- WHAT. Each function below is its LATEST body copied verbatim (every guard,
-- grant, signature and search_path unchanged); only the audit inserts gain
-- principal_id. Approval functions use p_approver_principal_id. Lock, unlock and
-- connector revoke have no principal argument, so they use
-- nopm_audit_principal(workspace, actor_type, actor_id): the user id for a user
-- actor, api_tokens.created_by for a token actor (NULL for a legacy token).
-- nopm_commit_task_deletion is NOT redefined: its latest body (0056) is not one
-- of the 0061-0069 functions.
--
-- ROLLBACK. Re-apply the previous bodies (0062 / 0063 / 0064 / 0069); drop
-- nopm_audit_principal(uuid, text, uuid).

create or replace function nopm_audit_principal(p_workspace_id uuid, p_actor_type text, p_actor_id uuid)
returns uuid
language sql
stable
set search_path = public
as $$
  select case
    when p_actor_type = 'user' then p_actor_id
    when p_actor_type = 'token' then (select t.created_by from api_tokens t where t.id = p_actor_id and t.workspace_id = p_workspace_id)
    else null
  end
$$;

revoke execute on function nopm_audit_principal(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function nopm_audit_principal(uuid, text, uuid) to service_role;

-- == nopm_apply_rebaseline (from 20261017000062) ==

create or replace function nopm_apply_rebaseline(
  p_rebaseline_id         uuid,
  p_workspace_id          uuid,
  p_actor_type            text,
  p_actor_id              uuid,
  p_actor_label           text,
  p_approver_principal_id uuid,
  p_channel               text default null,
  p_correlation_id        text default null,
  p_via_connector_id      uuid default null,
  p_external_event_id     text default null,
  p_external_actor_ref    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          rebaselines%rowtype;
  v_after    rebaselines%rowtype;
  v_proj     projects%rowtype;
  v_before   jsonb;
  v_pb_after jsonb;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if p_approver_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;
  if not exists (
    select 1 from profiles
     where id = p_approver_principal_id
       and workspace_id = p_workspace_id
       and role in ('admin', 'manager')
  ) then
    raise exception 'ROLE_NOT_PERMITTED: only managers and admins can approve' using errcode = 'P0018';
  end if;

  select * into r from rebaselines
    where id = p_rebaseline_id and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if r.requested_by is not null and r.requested_by = p_actor_id then
    raise exception 'SELF_APPROVAL' using errcode = 'P0003';
  end if;
  if r.requested_principal_id is not null and r.requested_principal_id = p_approver_principal_id then
    raise exception 'SELF_APPROVAL' using errcode = 'P0003';
  end if;
  if r.status::text <> 'approved' then
    raise exception 'ALREADY_DECIDED: rebaseline status is %', r.status using errcode = 'P0001';
  end if;

  -- D11: the sign-off was for a LOCKED project's schedule. Once unlocked the
  -- live dates may have moved, so the apply must not copy them as the baseline.
  select * into v_proj from projects
    where id = r.project_id and workspace_id = p_workspace_id
    for update;
  if not found or not v_proj.is_locked then
    raise exception 'PROJECT_NOT_LOCKED: the project is no longer locked' using errcode = 'P0019';
  end if;

  v_before := jsonb_build_object('start', v_proj.baseline_start_date, 'target', v_proj.baseline_target_date);

  perform nopm_apply_rebaseline_snapshot(r.project_id, p_workspace_id);

  select jsonb_build_object('start', baseline_start_date, 'target', baseline_target_date)
    into v_pb_after
    from projects where id = r.project_id and workspace_id = p_workspace_id;

  update rebaselines
     set status = 'applied', applied_at = now()
   where id = p_rebaseline_id and workspace_id = p_workspace_id
  returning * into v_after;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'rebaseline.apply', 'rebaseline', p_rebaseline_id,
            to_jsonb(r) - 'baseline_before',
            (to_jsonb(v_after) - 'baseline_before')
              || jsonb_build_object('project_baseline', jsonb_build_object('before', v_before, 'after', v_pb_after)),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id);

  return to_jsonb(v_after) - 'baseline_before';
end;
$$;

revoke execute on function nopm_apply_rebaseline(uuid, uuid, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_apply_rebaseline(uuid, uuid, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

-- == nopm_unlock_project_audited (from 20261017000062) ==

create or replace function nopm_unlock_project_audited(
  p_project_id         uuid,
  p_workspace_id       uuid,
  p_reason             text,
  p_actor_type         text,
  p_actor_id           uuid,
  p_actor_label        text,
  p_channel            text default null,
  p_correlation_id     text default null,
  p_via_connector_id   uuid default null,
  p_external_event_id  text default null,
  p_external_actor_ref text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before    projects%rowtype;
  v_project   projects%rowtype;
  v_cancelled jsonb;
  c           jsonb;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;

  select * into v_before from projects
    where id = p_project_id and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'NOT_FOUND: project not found' using errcode = 'P0002';
  end if;

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

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'project.unlock', 'project', p_project_id,
            to_jsonb(v_before),
            to_jsonb(v_project) || jsonb_build_object(
              'unlock_reason', p_reason,
              'cancelled_rebaselines', (select coalesce(jsonb_agg(e ->> 'id'), '[]'::jsonb) from jsonb_array_elements(v_cancelled) e)),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, nopm_audit_principal(p_workspace_id, p_actor_type, p_actor_id));

  -- One audit row per voided rebaseline, so each one's own history shows why it ended.
  for c in select e from jsonb_array_elements(v_cancelled) e loop
    insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
      values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
              'rebaseline.cancelled', 'rebaseline', (c ->> 'id')::uuid,
              jsonb_build_object('id', c ->> 'id', 'project_id', p_project_id, 'version', c -> 'version', 'status', c ->> 'previous_status'),
              jsonb_build_object('id', c ->> 'id', 'project_id', p_project_id, 'version', c -> 'version', 'status', 'cancelled',
                                 'reason', 'project_unlocked', 'unlock_reason', p_reason),
              p_channel, p_correlation_id,
              p_via_connector_id, p_external_event_id, p_external_actor_ref, nopm_audit_principal(p_workspace_id, p_actor_type, p_actor_id));
  end loop;

  return jsonb_build_object('project', to_jsonb(v_project), 'cancelled', v_cancelled);
end;
$$;

revoke execute on function nopm_unlock_project_audited(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_unlock_project_audited(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == nopm_signoff_rebaseline (from 20261017000063) ==

create or replace function nopm_signoff_rebaseline(
  p_rebaseline_id         uuid,
  p_workspace_id          uuid,
  p_vote                  text,
  p_comment               text,
  p_actor_type            text,
  p_actor_id              uuid,
  p_actor_label           text,
  p_approver_principal_id uuid,
  p_channel               text default null,
  p_correlation_id        text default null,
  p_via_connector_id      uuid default null,
  p_external_event_id     text default null,
  p_external_actor_ref    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          rebaselines%rowtype;
  v_after    rebaselines%rowtype;
  v_prev     rebaseline_signoffs%rowtype;
  v_sign     rebaseline_signoffs%rowtype;
  v_has_prev boolean;
  v_status   text;
  v_go       boolean;
  v_pending  boolean;
  v_nogo     boolean;
  ts         timestamptz := now();
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if p_approver_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;
  if not exists (
    select 1 from profiles
     where id = p_approver_principal_id
       and workspace_id = p_workspace_id
       and role in ('admin', 'manager')
  ) then
    raise exception 'ROLE_NOT_PERMITTED: only managers and admins can approve' using errcode = 'P0018';
  end if;

  select * into r from rebaselines
    where id = p_rebaseline_id and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if r.requested_by is not null and r.requested_by = p_actor_id then
    raise exception 'SELF_APPROVAL' using errcode = 'P0003';
  end if;
  if r.requested_principal_id is not null and r.requested_principal_id = p_approver_principal_id then
    raise exception 'SELF_APPROVAL' using errcode = 'P0003';
  end if;
  if r.status::text <> 'pending_approval' then
    raise exception 'ALREADY_DECIDED: rebaseline status is %', r.status using errcode = 'P0001';
  end if;

  select * into v_prev from rebaseline_signoffs
    where rebaseline_id = p_rebaseline_id and approver_id = p_approver_principal_id and workspace_id = p_workspace_id;
  v_has_prev := found;

  insert into rebaseline_signoffs (workspace_id, rebaseline_id, approver_id, approver_principal_id, vote, voted_at, comment)
    values (p_workspace_id, p_rebaseline_id, p_approver_principal_id, p_approver_principal_id, p_vote::vote_choice, ts, p_comment)
  on conflict (rebaseline_id, approver_id) do update
    set approver_principal_id = excluded.approver_principal_id,
        vote = excluded.vote, voted_at = excluded.voted_at, comment = excluded.comment
  returning * into v_sign;

  select coalesce(bool_or(vote::text = 'no_go'), false),
         coalesce(bool_or(vote::text = 'go'), false),
         coalesce(bool_or(vote::text = 'pending'), false)
    into v_nogo, v_go, v_pending
    from rebaseline_signoffs
   where rebaseline_id = p_rebaseline_id and workspace_id = p_workspace_id;

  v_status := case
    when v_nogo then 'rejected'
    when v_go and not v_pending then 'approved'
    else r.status::text
  end;

  update rebaselines set status = v_status::rebaseline_status
   where id = p_rebaseline_id and workspace_id = p_workspace_id
  returning * into v_after;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'rebaseline.signoff', 'rebaseline', p_rebaseline_id,
            (to_jsonb(r) - 'baseline_before') || jsonb_build_object('signoff',
              case when v_has_prev
                then jsonb_build_object('approver_id', p_approver_principal_id, 'vote', v_prev.vote, 'comment', v_prev.comment, 'voted_at', v_prev.voted_at)
                else null end),
            (to_jsonb(v_after) - 'baseline_before') || jsonb_build_object('signoff', jsonb_build_object(
              'approver_id', p_approver_principal_id, 'vote', p_vote, 'comment', p_comment, 'voted_at', ts,
              'previous_vote', case when v_has_prev then v_prev.vote::text else null end)),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id);

  return jsonb_build_object('signoff', to_jsonb(v_sign), 'rebaseline', to_jsonb(v_after) - 'baseline_before');
end;
$$;

revoke execute on function nopm_signoff_rebaseline(uuid, uuid, text, text, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_signoff_rebaseline(uuid, uuid, text, text, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

-- == nopm_decide_change_request (from 20261017000063) ==

create or replace function nopm_decide_change_request(
  p_id                    uuid,
  p_workspace_id          uuid,
  p_new_status            text,
  p_rationale             text,
  p_expected_updated_at   timestamptz,
  p_actor_type            text,
  p_actor_id              uuid,
  p_actor_label           text,
  p_approver_principal_id uuid,
  p_channel               text default null,
  p_correlation_id        text default null,
  p_via_connector_id      uuid default null,
  p_external_event_id     text default null,
  p_external_actor_ref    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cr      change_requests%rowtype;
  v_after change_requests%rowtype;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if p_new_status not in ('approved', 'rejected', 'deferred') then
    raise exception 'INVALID_STATUS' using errcode = 'P0001';
  end if;
  if p_approver_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;
  if not exists (
    select 1 from profiles
     where id = p_approver_principal_id
       and workspace_id = p_workspace_id
       and role in ('admin', 'manager')
  ) then
    raise exception 'ROLE_NOT_PERMITTED: only managers and admins can approve' using errcode = 'P0018';
  end if;

  select * into cr from change_requests
    where id = p_id and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if cr.status not in ('raised', 'under_review') then
    raise exception 'ALREADY_DECIDED: status is %', cr.status using errcode = 'P0001';
  end if;
  if (cr.requested_by is not null and cr.requested_by = p_actor_id)
     or (cr.requested_by_id is not null and cr.requested_by_id = p_actor_id and cr.requested_by_type::text = p_actor_type)
     or (cr.requested_principal_id is not null and cr.requested_principal_id = p_approver_principal_id) then
    raise exception 'SELF_APPROVAL' using errcode = 'P0003';
  end if;
  if p_expected_updated_at is not null and cr.updated_at <> p_expected_updated_at then
    raise exception 'PRECONDITION_FAILED' using errcode = 'P0021';
  end if;

  update change_requests set
    status               = p_new_status,
    decided_by           = case when p_actor_type = 'user' then p_actor_id else null end,
    decided_by_label     = p_actor_label,
    decided_by_type      = p_actor_type::actor_type,
    decided_by_id        = p_actor_id,
    decided_principal_id = p_approver_principal_id,
    decision_rationale   = p_rationale,
    decided_at           = now()
  where id = p_id and workspace_id = p_workspace_id
  returning * into v_after;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'change_request.decide', 'change_request', p_id,
            to_jsonb(cr), to_jsonb(v_after),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id);

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_decide_change_request(uuid, uuid, text, text, timestamptz, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_decide_change_request(uuid, uuid, text, text, timestamptz, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

-- == nopm_lock_project (from 20261017000063) ==

create or replace function nopm_lock_project(
  p_project_id         uuid,
  p_workspace_id       uuid,
  p_reason             text,
  p_actor_type         text,
  p_actor_id           uuid,
  p_actor_label        text,
  p_channel            text default null,
  p_correlation_id     text default null,
  p_via_connector_id   uuid default null,
  p_external_event_id  text default null,
  p_external_actor_ref text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before projects%rowtype;
  v_after  projects%rowtype;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;

  select * into v_before from projects
    where id = p_project_id and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'NOT_FOUND: project not found' using errcode = 'P0002';
  end if;

  -- Baseline snapshot, null-only (a baseline someone already set is never
  -- overwritten), while the project is still open: once locked the 0028 / 0049
  -- triggers refuse baseline_* writes. An already-locked project has nothing
  -- left to freeze.
  if not v_before.is_locked then
    update milestones
       set baseline_target_date = target_date
     where project_id = p_project_id and workspace_id = p_workspace_id
       and baseline_target_date is null and target_date is not null;

    update tasks
       set baseline_start_date = start_date,
           baseline_due_date   = due_date
     where project_id = p_project_id and workspace_id = p_workspace_id
       and baseline_start_date is null and baseline_due_date is null
       and (start_date is not null or due_date is not null);

    update projects
       set baseline_start_date  = coalesce(baseline_start_date, start_date),
           baseline_target_date = coalesce(baseline_target_date, target_date)
     where id = p_project_id and workspace_id = p_workspace_id;
  end if;

  update projects
     set is_locked = true,
         locked_by = case when p_actor_type = 'user' then p_actor_id else null end,
         locked_at = now(),
         lock_reason = p_reason
   where id = p_project_id and workspace_id = p_workspace_id
  returning * into v_after;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'project.lock', 'project', p_project_id,
            to_jsonb(v_before),
            to_jsonb(v_after) || jsonb_build_object('project_baseline', jsonb_build_object(
              'before', jsonb_build_object('start', v_before.baseline_start_date, 'target', v_before.baseline_target_date),
              'after',  jsonb_build_object('start', v_after.baseline_start_date,  'target', v_after.baseline_target_date))),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, nopm_audit_principal(p_workspace_id, p_actor_type, p_actor_id));

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_lock_project(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_lock_project(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == nopm_commit_project_deletion (from 20261017000064) ==

-- Same stale-overload guard as 0064 (a no-op: that signature is already gone).
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

  -- 0064 (D2): the cascade below destroys governed records. Their audit rows are
  -- written HERE, in the same transaction, from the rows as they are right now
  -- (the delete has not run yet): one row per change request, decision,
  -- document, rebaseline and rebaseline sign-off, each carrying its full row in
  -- `before` (a document's row keeps its storage_path, so an orphaned file can
  -- be traced). If the delete below finds nothing, the whole transaction rolls
  -- back and so do these rows.
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'change_request.cascade_delete', 'change_request', c.id, to_jsonb(c),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from change_requests c where c.project_id = r.target_id and c.workspace_id = p_workspace_id;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'decision.cascade_delete', 'decision', d.id, to_jsonb(d),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from decisions d where d.project_id = r.target_id and d.workspace_id = p_workspace_id;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'document.cascade_delete', 'document', dc.id, to_jsonb(dc),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from documents dc where dc.project_id = r.target_id and dc.workspace_id = p_workspace_id;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'rebaseline_signoff.cascade_delete', 'rebaseline_signoff', s.id, to_jsonb(s),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from rebaseline_signoffs s where s.workspace_id = p_workspace_id and s.rebaseline_id in (select id from rebaselines where project_id = r.target_id and workspace_id = p_workspace_id);
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'rebaseline.cascade_delete', 'rebaseline', rb.id, to_jsonb(rb),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from rebaselines rb where rb.project_id = r.target_id and rb.workspace_id = p_workspace_id;

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
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'project.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id);

  -- 4. audit the governance step itself — records the HUMAN behind the
  --    approver and the approver's optional note.
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'deletion_request.approved', 'deletion_request', r.id,
            jsonb_build_object('status', 'pending'),
            jsonb_build_object('status', 'committed', 'approver_principal_id', p_approver_principal_id)
              || case when v_note is not null then jsonb_build_object('note', v_note) else '{}'::jsonb end,
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id);

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

-- == nopm_revoke_connector (from 20261017000069) ==

create or replace function nopm_revoke_connector(
  p_workspace_id   uuid,
  p_connector_id   uuid,
  p_actor_type     text,
  p_actor_id       uuid,
  p_actor_label    text,
  p_before         jsonb,
  p_after          jsonb,
  p_revoked_at     timestamptz default now(),
  p_channel        text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_status     text;
  v_identities int := 0;
  v_deliveries int := 0;
begin
  select status into v_status
    from integration_connectors
   where id = p_connector_id and workspace_id = p_workspace_id
   for update;
  if not found then
    raise exception 'CONNECTOR_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status = 'revoked' then
    raise exception 'CONNECTOR_REVOKED' using errcode = 'P0001';
  end if;

  -- The connector first: this alone stops inbound and outbound.
  update integration_connectors
     set status = 'revoked', revoked_at = p_revoked_at
   where id = p_connector_id and workspace_id = p_workspace_id;

  update external_identities
     set revoked_at = p_revoked_at
   where workspace_id = p_workspace_id and connector_id = p_connector_id and revoked_at is null;
  get diagnostics v_identities = row_count;

  update integration_deliveries
     set status = 'superseded', last_error = 'connector revoked', locked_until = null
   where workspace_id = p_workspace_id and connector_id = p_connector_id
     and status in ('pending', 'retry');
  get diagnostics v_deliveries = row_count;

  delete from identity_link_codes
   where workspace_id = p_workspace_id and connector_id = p_connector_id and used_at is null;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'integration.connector.revoke', 'integration_connector', p_connector_id,
            p_before,
            coalesce(p_after, '{}'::jsonb) || jsonb_build_object(
              'identities_revoked', v_identities,
              'deliveries_superseded', v_deliveries),
            p_channel, p_correlation_id, nopm_audit_principal(p_workspace_id, p_actor_type, p_actor_id));

  return jsonb_build_object('identities_revoked', v_identities, 'deliveries_superseded', v_deliveries);
end;
$$;

revoke execute on function nopm_revoke_connector(uuid, uuid, text, uuid, text, jsonb, jsonb, timestamptz, text, text) from public, anon, authenticated;
grant  execute on function nopm_revoke_connector(uuid, uuid, text, uuid, text, jsonb, jsonb, timestamptz, text, text) to service_role;


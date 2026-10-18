-- NoPM · 0063 (2026-10-17) — rebaseline sign-off, change-request decision and
-- project lock write their audit row INSIDE the transaction that makes the change.
--
-- WHY (audit A3-3, A3-19, D10). Each of these did its mutation(s) through the
-- API and wrote the audit row afterwards, so a failure in between left a vote, a
-- decision or a lock (with its baseline snapshot) that the trail never saw. The
-- lock route also snapshot baselines with one UPDATE per row, so a failure half
-- way left a partly baselined project.
--
-- WHAT. Three NEW functions (exactly one audit row per logical mutation, as
-- today; the previous build keeps working until replaced):
--   nopm_signoff_rebaseline(...)       vote upsert + status from votes +
--                                      rebaseline.signoff audit row.
--   nopm_decide_change_request(...)    compare-and-set decision +
--                                      change_request.decide audit row.
--   nopm_lock_project(...)             null-only baseline snapshot (set based),
--                                      lock, project.lock audit row.
-- The two decision functions also check that the approver PRINCIPAL is an admin
-- or manager (owner decision D-16, defence in depth behind requireApprover).
-- Error codes: P0001 ALREADY_DECIDED, P0002 NOT_FOUND, P0003 SELF_APPROVAL,
--   P0005 INVALID_CHANNEL, P0006 NO_PRINCIPAL, P0018 ROLE_NOT_PERMITTED,
--   P0021 PRECONDITION_FAILED (change request edited since the caller read it).
--
-- ORDER OF APPLY. Apply BEFORE deploying the build that calls them.
-- ROLLBACK. Drop the three functions.

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

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
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
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  return jsonb_build_object('signoff', to_jsonb(v_sign), 'rebaseline', to_jsonb(v_after) - 'baseline_before');
end;
$$;

revoke execute on function nopm_signoff_rebaseline(uuid, uuid, text, text, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_signoff_rebaseline(uuid, uuid, text, text, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

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

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'change_request.decide', 'change_request', p_id,
            to_jsonb(cr), to_jsonb(v_after),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_decide_change_request(uuid, uuid, text, text, timestamptz, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_decide_change_request(uuid, uuid, text, text, timestamptz, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

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

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'project.lock', 'project', p_project_id,
            to_jsonb(v_before),
            to_jsonb(v_after) || jsonb_build_object('project_baseline', jsonb_build_object(
              'before', jsonb_build_object('start', v_before.baseline_start_date, 'target', v_before.baseline_target_date),
              'after',  jsonb_build_object('start', v_after.baseline_start_date,  'target', v_after.baseline_target_date))),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_lock_project(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_lock_project(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) to service_role;

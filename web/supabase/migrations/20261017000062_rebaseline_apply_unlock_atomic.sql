-- NoPM · 0062 (2026-10-17) — rebaseline apply and project unlock write their audit
-- rows INSIDE the transaction that makes the change.
--
-- WHY (audit A3-2, A3-3, D10, D11). The apply route moved the baselines in one
-- RPC, flipped approved -> applied in a second statement and wrote the audit row
-- in a third: a failure after the flip left an applied rebaseline with no audit
-- row, and `applied` is terminal so nothing could write the missing row later.
-- Unlock had the same shape (unlock + cancellations in one RPC, audit rows from
-- the route afterwards). Apply also never checked that the project was still
-- locked.
--
-- WHAT. Two NEW functions (the 0028/0055/0058 ones stay, so the build that is
-- live today keeps working until it is replaced):
--   nopm_apply_rebaseline(...)          approver checks, snapshot, approved ->
--                                       applied and the single rebaseline.apply
--                                       audit row, atomically.
--   nopm_unlock_project_audited(...)    unlock + cancel open rebaselines + the
--                                       project.unlock audit row + one
--                                       rebaseline.cancelled row per voided one,
--                                       atomically.
-- Error codes raised (decide.ts / the routes map them):
--   P0002 NOT_FOUND          P0001 ALREADY_DECIDED (rebaseline is not 'approved')
--   P0003 SELF_APPROVAL      P0006 NO_PRINCIPAL
--   P0005 INVALID_CHANNEL    P0018 ROLE_NOT_PERMITTED (owner decision D-16)
--   P0019 PROJECT_NOT_LOCKED (D11: apply refused once the project is unlocked)
--
-- ORDER OF APPLY. Apply BEFORE deploying the build that calls them.
-- ROLLBACK. drop function nopm_apply_rebaseline(...); drop function
--           nopm_unlock_project_audited(...).

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

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'rebaseline.apply', 'rebaseline', p_rebaseline_id,
            to_jsonb(r) - 'baseline_before',
            (to_jsonb(v_after) - 'baseline_before')
              || jsonb_build_object('project_baseline', jsonb_build_object('before', v_before, 'after', v_pb_after)),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  return to_jsonb(v_after) - 'baseline_before';
end;
$$;

revoke execute on function nopm_apply_rebaseline(uuid, uuid, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_apply_rebaseline(uuid, uuid, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

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

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'project.unlock', 'project', p_project_id,
            to_jsonb(v_before),
            to_jsonb(v_project) || jsonb_build_object(
              'unlock_reason', p_reason,
              'cancelled_rebaselines', (select coalesce(jsonb_agg(e ->> 'id'), '[]'::jsonb) from jsonb_array_elements(v_cancelled) e)),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  -- One audit row per voided rebaseline, so each one's own history shows why it ended.
  for c in select e from jsonb_array_elements(v_cancelled) e loop
    insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
      values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
              'rebaseline.cancelled', 'rebaseline', (c ->> 'id')::uuid,
              jsonb_build_object('id', c ->> 'id', 'project_id', p_project_id, 'version', c -> 'version', 'status', c ->> 'previous_status'),
              jsonb_build_object('id', c ->> 'id', 'project_id', p_project_id, 'version', c -> 'version', 'status', 'cancelled',
                                 'reason', 'project_unlocked', 'unlock_reason', p_reason),
              p_channel, p_correlation_id,
              p_via_connector_id, p_external_event_id, p_external_actor_ref);
  end loop;

  return jsonb_build_object('project', to_jsonb(v_project), 'cancelled', v_cancelled);
end;
$$;

revoke execute on function nopm_unlock_project_audited(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_unlock_project_audited(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) to service_role;

-- NoPM · 0086 (2026-10-18) — atomic sprint close + change-request consumption (review R3-7, R3-9).
--
--   1. nopm_close_sprint (new): closing a sprint is ONE transaction - the
--      active -> closed move, the completed snapshot, the move of the unfinished
--      tasks and the single sprint.closed audit row. A failure anywhere leaves the
--      sprint active and its tasks untouched, and a task attached after the
--      caller's read is still moved (the tasks are read here, under the lock).
--   2. change_requests.budget_consumed_at / budget_consumed_by (new, nullable):
--      a locked project's budget change references an approved change request;
--      that request is consumed by the first budget change that uses it and
--      cannot authorise a second one (decision 23).
--
-- NEW ERRCODES (unused before): P0025 SPRINT_NOT_ACTIVE, P0026 UNFINISHED_TASKS,
--   P0027 INVALID_DESTINATION.
-- BACKWARD COMPATIBLE: one additive column pair and one new function; the previous
-- build ignores both. ROLLBACK: drop function nopm_close_sprint(...); drop the columns.

alter table change_requests
  add column if not exists budget_consumed_at timestamptz,
  add column if not exists budget_consumed_by uuid references projects(id) on delete set null;

comment on column change_requests.budget_consumed_at is
  'When this approved change request authorised a budget change on its locked project. One request authorises one change; NULL = not yet used.';

create or replace function nopm_close_sprint(
  p_sprint_id          uuid,
  p_workspace_id       uuid,
  p_move_to            text,
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
  v_before     sprints%rowtype;
  v_after      sprints%rowtype;
  v_dest       sprints%rowtype;
  v_dest_id    uuid;
  v_unfinished uuid[];
  v_points     numeric;
  v_snapshot   jsonb;
  v_after_json jsonb;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;

  select * into v_before from sprints
    where id = p_sprint_id and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'NOT_FOUND: sprint not found' using errcode = 'P0002';
  end if;
  if v_before.state <> 'active' then
    raise exception 'SPRINT_NOT_ACTIVE: Sprint must be active to close' using errcode = 'P0025';
  end if;

  -- Lock the attached tasks so nothing changes status under us, then read them.
  perform 1 from tasks where workspace_id = p_workspace_id and sprint_id = p_sprint_id for update;

  select coalesce(array_agg(id), '{}') into v_unfinished
    from tasks
   where workspace_id = p_workspace_id and sprint_id = p_sprint_id
     and status_type not in ('completed', 'canceled');

  select coalesce(sum(coalesce(story_points, 0)), 0),
         coalesce(jsonb_object_agg(id::text, round(coalesce(story_points, 0)::numeric, 1)), '{}'::jsonb)
    into v_points, v_snapshot
    from tasks
   where workspace_id = p_workspace_id and sprint_id = p_sprint_id and status_type = 'completed';

  if coalesce(array_length(v_unfinished, 1), 0) > 0 then
    if p_move_to is null then
      raise exception 'UNFINISHED_TASKS: choose where the unfinished tasks go' using errcode = 'P0026';
    end if;
    if p_move_to <> 'backlog' then
      begin
        v_dest_id := p_move_to::uuid;
      exception when invalid_text_representation then
        raise exception 'INVALID_DESTINATION' using errcode = 'P0027';
      end;
      select * into v_dest from sprints
        where id = v_dest_id and workspace_id = p_workspace_id
        for share;
      if not found or v_dest.id = p_sprint_id or v_dest.project_id <> v_before.project_id or v_dest.state = 'closed' then
        raise exception 'INVALID_DESTINATION' using errcode = 'P0027';
      end if;
    end if;
  end if;

  update sprints
     set state = 'closed',
         closed_at = now(),
         completed_points = round(v_points, 1),
         completed_snapshot = v_snapshot
   where id = p_sprint_id and workspace_id = p_workspace_id
  returning * into v_after;

  if coalesce(array_length(v_unfinished, 1), 0) > 0 then
    update tasks set sprint_id = v_dest_id
     where workspace_id = p_workspace_id and sprint_id = p_sprint_id and id = any (v_unfinished);
  end if;

  v_after_json := to_jsonb(v_after);
  if coalesce(array_length(v_unfinished, 1), 0) > 0 then
    v_after_json := v_after_json || jsonb_build_object('moved_unfinished',
      jsonb_build_object('to', coalesce(v_dest_id::text, 'backlog'), 'task_ids', to_jsonb(v_unfinished)));
  end if;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'sprint.closed', 'sprint', p_sprint_id,
            to_jsonb(v_before), v_after_json,
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref,
            nopm_audit_principal(p_workspace_id, p_actor_type, p_actor_id));

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_close_sprint(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_close_sprint(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) to service_role;

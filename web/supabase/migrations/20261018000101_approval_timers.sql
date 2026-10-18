-- NoPM · 0101 approval timers (2026-10-18, audit gaps G3 + G4, assumptions A1 and A3).
--
-- THE GAP. A request waited for an approver for ever and nothing recorded that it was late,
-- that somebody was reminded, or that an emergency change was still owed its retro decision.
--
-- THE FIX.
--   1. approval_events: an append-style ledger of what the daily timer did to a request
--      (deadline_set, reminder_sent, escalated, auto_approved, retro_overdue). One row per
--      (target, kind): the unique index is the "once" rule, so a second cron tick the same
--      day cannot remind, escalate or flag twice. The timer writes HERE and never touches the
--      request row, so an approver's pinned version (updated_at) is not invalidated by a reminder.
--      RLS select-only for workspace members, writes revoked from the browser roles (0048 style).
--   2. nopm_auto_approve_routine: approves a ROUTINE change request that is past its turnaround
--      deadline, ONLY when the workspace policy has tiers.routine.auto_approve = true (CR A1, OFF
--      by default). One transaction: the decision, the approval_events row and ONE audit row
--      (change_request.decide, actor 'system:auto-approve (policy)', no principal). It refuses
--      any other tier, a request carrying money or dates, an emergency, and a request that is
--      not yet due. The audit actor is the nil-uuid system actor (audit_log.actor_type is an enum
--      of user|token, so the system actor is recorded as 'token', like every other system job).
--
--   3. nopm_update_workspace_settings (W4-03): the workspace settings PATCH (including the approval policy)
--      and its workspace.settings_update audit row are ONE transaction. A generic nopm_mutate_audited
--      cannot do it (workspaces is keyed by id, not workspace_id), so this is a dedicated function with
--      its own column whitelist. p_expected pins the values the caller read: if any of those columns
--      changed since (two admins saving at once) the call fails with P0034 STALE_ROW and nothing is written.
--
-- SQLSTATEs (each used for ONE meaning across the whole migration set, W4-10): P0031 AUTO_APPROVE_OFF,
-- P0032 NOT_ROUTINE, P0033 NOT_DUE, P0034 STALE_ROW (settings pin), P0035 FORBIDDEN_COLUMN (settings).
-- 0100 takes P0030 TIER_LOCKED. P0002 NOT_FOUND and P0005 INVALID_CHANNEL keep their repo-wide meaning.
-- 0102 owns P0040 to P0042 and 0103 owns P0051 to P0056, so none of the above clashes with them.
--
-- Additive. ROLLBACK: drop function nopm_auto_approve_routine(...), nopm_update_workspace_settings(...); drop table approval_events.

create table if not exists approval_events (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  target_type  text not null check (target_type in ('change_request', 'deletion_request', 'rebaseline')),
  target_id    uuid not null,
  kind         text not null check (kind in ('deadline_set', 'reminder_sent', 'escalated', 'auto_approved', 'retro_overdue')),
  at           timestamptz not null default now(),
  actor_label  text not null default 'system:approval-timer',
  detail       jsonb
);

-- One of each kind per request: the once-only rule of the daily timer.
create unique index if not exists approval_events_once
  on approval_events (target_type, target_id, kind);
create index if not exists approval_events_workspace_at_idx
  on approval_events (workspace_id, at desc);

alter table approval_events enable row level security;

-- Second layer (as 0048): even a future careless write policy cannot open this to the browser.
revoke insert, update, delete on approval_events from anon, authenticated;

drop policy if exists "read approval_events" on approval_events;
create policy "read approval_events" on approval_events
  for select using (workspace_id = nopm_current_workspace());

comment on table approval_events is 'what the daily approval timer did to a request (reminder, escalation, auto-approval, overdue retro); one row per kind per request';

-- == nopm_auto_approve_routine ==

create or replace function nopm_auto_approve_routine(
  p_workspace_id uuid,
  p_id           uuid,
  p_now          timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_system constant uuid := '00000000-0000-0000-0000-000000000000';
  c_label  constant text := 'system:auto-approve (policy)';
  v_policy jsonb;
  cr       change_requests%rowtype;
  v_after  change_requests%rowtype;
  v_hours  text;
begin
  select approval_policy into v_policy from workspaces where id = p_workspace_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- OFF unless an admin switched it on for the routine tier (CR A1).
  if coalesce((v_policy #>> '{tiers,routine,auto_approve}')::boolean, false) is not true then
    raise exception 'AUTO_APPROVE_OFF: the workspace policy does not allow auto-approval' using errcode = 'P0031';
  end if;

  select * into cr from change_requests
    where id = p_id and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Money and dates are never auto-approved: the tier guard inside the function (CR A1).
  if cr.tier <> 'routine' or cr.is_emergency then
    raise exception 'NOT_ROUTINE: only a routine request can be auto-approved' using errcode = 'P0032';
  end if;
  if coalesce(cr.impact_cost, 0) <> 0 or coalesce(cr.impact_schedule_days, 0) <> 0
     or (cr.impact_scope is not null and jsonb_array_length(cr.impact_scope) > 0) then
    raise exception 'NOT_ROUTINE: a request with a cost, a schedule impact or a scope impact is never auto-approved' using errcode = 'P0032';
  end if;
  if cr.status not in ('raised', 'under_review') then
    raise exception 'ALREADY_DECIDED: status is %', cr.status using errcode = 'P0001';
  end if;
  if cr.approval_deadline_at is null or cr.approval_deadline_at > p_now then
    raise exception 'NOT_DUE: the turnaround has not passed' using errcode = 'P0033';
  end if;

  v_hours := coalesce(v_policy #>> '{tiers,routine,turnaround_hours}', '24');

  update change_requests set
    status               = 'approved',
    decided_by           = null,
    decided_by_label     = c_label,
    decided_by_type      = 'token'::actor_type,
    decided_by_id        = c_system,
    decided_principal_id = null,
    decision_rationale   = format('Auto-approved by workspace policy: no decision within the %s-hour turnaround for a routine request.', v_hours),
    decided_at           = now()
  where id = p_id and workspace_id = p_workspace_id
  returning * into v_after;

  insert into approval_events (workspace_id, target_type, target_id, kind, actor_label, detail)
    values (p_workspace_id, 'change_request', p_id, 'auto_approved', c_label,
            jsonb_build_object('turnaround_hours', v_hours, 'deadline', cr.approval_deadline_at));

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, request_id, principal_id)
    values (p_workspace_id, 'token'::actor_type, c_system, c_label,
            'change_request.decide', 'change_request', p_id,
            to_jsonb(cr), to_jsonb(v_after) || jsonb_build_object('auto_approved', true),
            'cron', null);

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_auto_approve_routine(uuid, uuid, timestamptz) from public, anon, authenticated;
grant  execute on function nopm_auto_approve_routine(uuid, uuid, timestamptz) to service_role;

-- == nopm_update_workspace_settings (W4-03) ==

create or replace function nopm_update_workspace_settings(
  p_workspace_id uuid,
  p_patch        jsonb,
  p_expected     jsonb,
  p_audit        jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_writable constant text[] := array[
    'approval_policy', 'stale_days', 'nudges_enabled', 'weekly_report_enabled',
    'weekly_report_day', 'time_zone', 'work_event_rules'
  ];
  v_patch   jsonb := coalesce(p_patch, '{}'::jsonb);
  v_expect  jsonb := coalesce(p_expected, '{}'::jsonb);
  v_channel text := nullif(p_audit ->> 'channel', '');
  v_key     text;
  v_sets    text;
  v_before  jsonb;
  v_after   jsonb;
begin
  if p_workspace_id is null or jsonb_typeof(v_patch) <> 'object' or jsonb_typeof(v_expect) <> 'object' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_channel is not null and v_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark', 'github') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  for v_key in select jsonb_object_keys(v_patch) loop
    if not (v_key = any (c_writable)) then
      raise exception 'FORBIDDEN_COLUMN: %', v_key using errcode = 'P0035';
    end if;
  end loop;

  select to_jsonb(w.*) into v_before from workspaces w where w.id = p_workspace_id for update;
  if v_before is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Pin: every column the caller read must still hold what it read.
  for v_key in select jsonb_object_keys(v_expect) loop
    if (v_before -> v_key) is distinct from (v_expect -> v_key) then
      raise exception 'STALE_ROW' using errcode = 'P0034';
    end if;
  end loop;

  select string_agg(format('%1$I = (jsonb_populate_record(null::workspaces, $1)).%1$I', k), ', ')
    into v_sets
    from (select jsonb_object_keys(v_patch) as k) keys;
  if v_sets is null then
    v_after := v_before;
  else
    execute format('update workspaces w set %s where w.id = $2 returning to_jsonb(w.*)', v_sets)
      into v_after using v_patch, p_workspace_id;
  end if;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id,
                         before, after, channel, request_id, principal_id,
                         via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id,
            (p_audit ->> 'actor_type')::actor_type,
            (p_audit ->> 'actor_id')::uuid,
            p_audit ->> 'actor_label',
            coalesce(nullif(p_audit ->> 'action', ''), 'workspace.settings_update'),
            'workspace',
            p_workspace_id,
            nullif(p_audit -> 'before', 'null'::jsonb),
            nullif(p_audit -> 'after', 'null'::jsonb),
            v_channel,
            nullif(p_audit ->> 'request_id', ''),
            nullif(p_audit ->> 'principal_id', '')::uuid,
            nullif(p_audit ->> 'via_connector_id', '')::uuid,
            nullif(p_audit ->> 'external_event_id', ''),
            nullif(p_audit ->> 'external_actor_ref', ''));

  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;

revoke execute on function nopm_update_workspace_settings(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function nopm_update_workspace_settings(uuid, jsonb, jsonb, jsonb) to service_role;

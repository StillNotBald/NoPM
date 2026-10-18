-- NoPM · 0106 tier decisions (2026-10-18, UAT cycle 2; owner decisions Q1, Q4, Q5 recorded 20:15 MYT).
--
-- WHAT THE OWNER DECIDED.
--   Q1  Emergency = flag only. An emergency change request commits when it is raised. It needs no
--       approver, no 48-hour admin retro, no retro deadline, no overdue state, no overdue notice.
--   Q4  Approved documents = manager tier. Changing or deleting an approved document is tracked by the
--       audit trail and decided like any other document: no admin gate.
--   Q5  An expense deletion at or above the workspace currency threshold is high risk (admin), like a
--       project deletion.
--
-- WHAT THIS MIGRATION DOES (additive; nothing is dropped; safe on the live rows at ledger 0105).
--   1. cr_emergency_shape no longer asks for retro_due_at, and retro_outcome may now also read
--      'not_required' (an emergency raised after this migration) or 'retired' (an emergency that was
--      waiting for its retro decision when this ran). cr_maker_checker accepts an emergency request
--      with no decider in status approved as well as emergency and implemented: nobody decides it.
--   2. nopm_decide_change_request is recreated (same signature, one overload). It decides only
--      raised and under_review requests, so an emergency request (already approved) answers
--      ALREADY_DECIDED. The tier-role refusal reads "only admins can approve a request at the high_risk tier".
--   3. nopm_commit_document_deletion is recreated without the approved-document admin gate
--      (P0041 requester, P0042 approver are retired; the codes stay reserved and are not reused).
--   4. nopm_deletion_tier_default also lifts an expense deletion to high_risk when its amount reaches
--      the workspace currency_threshold (default 50000, same number the change-request rule uses).
--   5. DATA (function nopm_apply_tier_decisions: run once at the end of this file, re-runnable for stragglers), one audit row per request touched:
--        a. every emergency change request that was waiting for a retro decision (status emergency, or
--           status implemented with retro_decided_at null) is closed out by owner decision: retro_decided_at
--           = now, retro_outcome = 'retired'. A request still in status emergency (not yet live) becomes
--           'approved', the status an approval would have given it. Audit action
--           change_request.retro_retired, actor "system (migration 0106)".
--        b. every PENDING expense deletion request at or above the threshold that is still 'normal' becomes
--           'high_risk'. Audit action deletion_request.tier_raised.
--      Emergency requests already decided at their retro keep their outcome untouched. A second run finds
--      nothing to do.
--   6. The retro timer reads nothing: the application stops evaluating retro_due_at. The columns
--      stay (history), documented as deprecated.
--
-- SQLSTATE added: P0043 EMERGENCY_NOT_PERMITTED (emergency guard trigger). P0041 and P0042 stay reserved (retired by Q4).
-- Also: a trigger so only a manager or admin principal can create an emergency request (any writer), and
-- nopm_raise_emergency_change_request, which inserts the request and its two audit rows in one transaction.
-- ROLLBACK: re-apply the 0100 decide function, the 0102 document and tier-default functions and the
-- 0100 cr_emergency_shape / cr_maker_checker bodies. The data step is not reversible; the audit rows say what was changed.

-- == 1. constraints ==

alter table change_requests drop constraint if exists cr_emergency_shape;
alter table change_requests
  add constraint cr_emergency_shape
  check (
    is_emergency = (tier = 'emergency')
    and (status <> 'emergency' or is_emergency)
    and (retro_outcome is null or (retro_outcome in ('approved', 'rejected', 'deferred', 'not_required', 'retired') and is_emergency))
    and ((retro_outcome is null) = (retro_decided_at is null))
  ) not valid;

alter table change_requests drop constraint if exists cr_maker_checker;
alter table change_requests
  add constraint cr_maker_checker check (
    status in ('raised', 'under_review')
    or (is_emergency and status in ('emergency', 'approved', 'implemented') and decided_by_id is null)
    or (
      decided_by_id is not null
      and (
        requested_by_id is null
        or decided_by_id <> requested_by_id
        or decided_by_type <> requested_by_type
      )
    )
  ) not valid;

-- The two checks must hold for the rows as they are NOW, so the data step below is validated by them.
do $$
declare c text;
begin
  foreach c in array array['change_requests:cr_emergency_shape', 'change_requests:cr_maker_checker'] loop
    begin
      execute format('alter table %I validate constraint %I', split_part(c, ':', 1), split_part(c, ':', 2));
    exception when others then
      raise notice '0106: % left NOT VALID (%)', split_part(c, ':', 2), sqlerrm;
    end;
  end loop;
end $$;

comment on column change_requests.retro_due_at is 'DEPRECATED (0106, owner decision Q1): emergency changes need no retro decision; null for every emergency raised since';
comment on column change_requests.retro_decided_at is 'DEPRECATED (0106): set on an emergency at raise (not_required) or when its retro requirement was retired';
comment on column change_requests.retro_outcome is 'DEPRECATED (0106): approved | rejected | deferred (old retro decisions), not_required (emergency raised since 0106), retired (retro requirement retired by owner decision Q1)';

-- == 2. nopm_decide_change_request (from 0100): an emergency change is never decided ==

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
  -- Q1: an emergency change committed when it was raised. There is nothing left to decide.
  if cr.is_emergency then
    raise exception 'ALREADY_DECIDED: an emergency change commits when it is raised and needs no decision' using errcode = 'P0001';
  end if;
  if cr.status not in ('raised', 'under_review') then
    raise exception 'ALREADY_DECIDED: status is %', cr.status using errcode = 'P0001';
  end if;
  -- G1/G2: the tier names the role that decides.
  if not nopm_principal_meets_tier(p_workspace_id, cr.tier, p_approver_principal_id) then
    raise exception 'ROLE_NOT_PERMITTED: only %s can approve a request at the % tier', nopm_tier_required_role(p_workspace_id, cr.tier), cr.tier using errcode = 'P0018';
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
            to_jsonb(cr),
            -- D7: a manager who decided an admin-tier request only because the workspace has fewer than two admins.
            case when nopm_principal_uses_fallback(p_workspace_id, cr.tier, p_approver_principal_id)
                 then to_jsonb(v_after) || jsonb_build_object('fallback_approver', true)
                 else to_jsonb(v_after) end,
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id);

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_decide_change_request(uuid, uuid, text, text, timestamptz, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_decide_change_request(uuid, uuid, text, text, timestamptz, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

-- == 3. documents: Q4 ==

-- == nopm_commit_document_deletion (0102, minus the approved-document admin gate: Q4) ==

drop function if exists nopm_commit_document_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_document_deletion(
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
  v_status text;
  v_path text;
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'document'
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
  -- Tier role (0100): the approver must meet the request's tier. Same helper and message as the deletion_requests trigger,
  -- raised here so the refusal names the tier's role before anything is deleted.
  if not nopm_principal_meets_tier(p_workspace_id, r.tier, p_approver_principal_id) then
    raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(p_workspace_id, r.tier), r.tier using errcode = 'P0018';
  end if;

  -- Owner decision Q4 (2026-10-18): an approved document is deleted on the manager tier like any other document.
  -- The request tier (normal) names the approver role; there is no admin gate (0102's P0041 and P0042 checks are retired).
  -- Its status is still read here so the stored file path comes back for the caller.
  select d.status, d.storage_path into v_status, v_path from documents d
    where d.id = r.target_id and d.workspace_id = p_workspace_id;

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop trigger through for this
  --    transaction only; nothing else sets it.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from documents where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the document no longer exists, so there is nothing to delete'
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
            'document.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id);

  -- 4. audit the governance step itself, with the human behind the approver and the optional note.
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
    'target_id', r.target_id,
    'document_path', v_path
  );
end;
$$;

revoke execute on function nopm_commit_document_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_document_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == 4. expenses: Q5 ==

-- A project deletion starts at high_risk (0100). An expense deletion does too when the amount reaches the
-- workspace currency threshold (policy.currency_threshold, default 50000; compared as plain numbers, like the
-- change-request rule in nopm_cr_tier_guard). Only a 'normal' tier is lifted: a requester may always ask for more.
create or replace function nopm_deletion_tier_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount    numeric;
  v_threshold numeric;
begin
  if new.tier = 'normal' then
    if new.target_type = 'project' then
      new.tier := 'high_risk';
    elsif new.target_type = 'expense' then
      select abs(coalesce(e.amount, 0)) into v_amount
        from expenses e where e.id = new.target_id and e.workspace_id = new.workspace_id;
      select coalesce((w.approval_policy ->> 'currency_threshold')::numeric, 50000) into v_threshold
        from workspaces w where w.id = new.workspace_id;
      if v_amount is not null and v_amount <> 0 and v_amount >= coalesce(v_threshold, 50000) then
        new.tier := 'high_risk';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_deletion_tier_default() from public, anon, authenticated;
grant  execute on function nopm_deletion_tier_default() to service_role;

-- == 5. data: existing live rows == (see nopm_apply_tier_decisions at the end of this file)

-- == 6. GitHub work events: no event completes a task (owner decision Q7, R-160) ==
-- Order matters: rewrite stored rules first, then the default, then the stricter check function.
-- workspaces has no triggers, so the update is a plain one-column rewrite; one audit row per workspace changed.

with old as (
  select w.id, w.work_event_rules as rules
    from workspaces w
   where exists (select 1 from jsonb_each(w.work_event_rules) e where e.value = '"completed"'::jsonb)
     for update
),
changed as (
  update workspaces w
     set work_event_rules = (
       select coalesce(jsonb_object_agg(e.key, case when e.value = '"completed"'::jsonb then 'null'::jsonb else e.value end), '{}'::jsonb)
         from jsonb_each(old.rules) e
     )
    from old
   where w.id = old.id
  returning w.id, old.rules as before_rules, w.work_event_rules as after_rules
)
insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after)
  select id, 'user'::actor_type, null, 'system (migration 0106)',
         'work_event_rules.update', 'workspace', id,
         jsonb_build_object('work_event_rules', before_rules),
         jsonb_build_object('work_event_rules', after_rules,
                            'reason', 'No work event completes a task; completion is a human action.')
    from changed;

alter table workspaces
  alter column work_event_rules set default
    '{"pr_opened": "started", "pr_merged": "in_review", "pr_closed": null, "deploy_success": null, "deploy_failure": null}'::jsonb;

create or replace function nopm_valid_work_event_rules(r jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when r is null or jsonb_typeof(r) <> 'object' then false
    else
      not exists (
        select 1 from jsonb_object_keys(r) k
        where k not in ('pr_opened', 'pr_merged', 'pr_closed', 'deploy_success', 'deploy_failure')
      )
      and not exists (
        select 1 from jsonb_each(r) e
        where jsonb_typeof(e.value) <> 'null'
          and not (
            jsonb_typeof(e.value) = 'string'
            and (e.value #>> '{}') in ('unstarted', 'started', 'in_review', 'canceled')
          )
      )
  end
$$;

-- == 7. who may create an emergency change: the database says it too (review C2-02) ==
-- Q1 removed the approver, so the raiser is the only control. A change request with the emergency flag is
-- accepted only when its requester principal is an admin or manager of the same workspace (a token resolves to
-- its creator, which is how requested_principal_id is filled). The flag can never be set on an existing row.
-- The agent-token rule (exact change:decide scope) lives in the route, because the database does not see scopes.
-- SQLSTATE P0043 EMERGENCY_NOT_PERMITTED (0102 owns P0040 to P0042, 0103 owns P0051 to P0056).

create or replace function nopm_cr_emergency_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.is_emergency and not old.is_emergency then
      raise exception 'EMERGENCY_NOT_PERMITTED: the emergency flag is set when a request is raised, never afterwards' using errcode = 'P0043';
    end if;
    return new;
  end if;
  if new.is_emergency then
    if new.requested_principal_id is null
       or not exists (
         select 1 from profiles
          where id = new.requested_principal_id
            and workspace_id = new.workspace_id
            and role in ('admin', 'manager')
       ) then
      raise exception 'EMERGENCY_NOT_PERMITTED: only a manager or admin can raise an emergency change' using errcode = 'P0043';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_cr_emergency_guard() from public, anon, authenticated;
grant  execute on function nopm_cr_emergency_guard() to service_role;

drop trigger if exists trg_cr_emergency_guard on change_requests;
create trigger trg_cr_emergency_guard
  before insert or update on change_requests
  for each row execute function nopm_cr_emergency_guard();

-- == 8. raising an emergency: the request and both audit rows in ONE transaction (review C2-03) ==
-- p_input carries the request fields the raiser chose (project_id, reference_id, title, description, category,
-- priority, impact_summary, impact_schedule_days, impact_cost, impact_scope, target_date, raised_at, requested_by,
-- requested_by_label, requested_by_type, requested_by_id). Everything about the emergency itself is set here.

create or replace function nopm_raise_emergency_change_request(
  p_workspace_id       uuid,
  p_input              jsonb,
  p_actor_type         text,
  p_actor_id           uuid,
  p_actor_label        text,
  p_principal_id       uuid,
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
  r      change_requests%rowtype;
  v_now  timestamptz := now();
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark', 'github') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if p_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;

  insert into change_requests (
    workspace_id, project_id, reference_id, title, description, category, priority, status, tier, is_emergency,
    impact_summary, impact_schedule_days, impact_cost, impact_scope, target_date, raised_at,
    requested_by, requested_by_label, requested_by_type, requested_by_id, requested_principal_id,
    decided_at, decided_by_label, decision_rationale, retro_decided_at, retro_outcome
  ) values (
    p_workspace_id,
    nullif(p_input ->> 'project_id', '')::uuid,
    nullif(p_input ->> 'reference_id', ''),
    p_input ->> 'title',
    p_input ->> 'description',
    coalesce(p_input ->> 'category', 'scope'),
    coalesce(p_input ->> 'priority', 'medium'),
    'approved', 'emergency', true,
    p_input ->> 'impact_summary',
    nullif(p_input ->> 'impact_schedule_days', '')::int,
    nullif(p_input ->> 'impact_cost', '')::numeric,
    case when jsonb_typeof(p_input -> 'impact_scope') = 'array' then p_input -> 'impact_scope' else null end,
    nullif(p_input ->> 'target_date', '')::date,
    coalesce(nullif(p_input ->> 'raised_at', '')::timestamptz, v_now),
    nullif(p_input ->> 'requested_by', '')::uuid,
    p_input ->> 'requested_by_label',
    nullif(p_input ->> 'requested_by_type', '')::actor_type,
    nullif(p_input ->> 'requested_by_id', '')::uuid,
    p_principal_id,
    v_now, 'Emergency path (no approval required)',
    'Emergency: committed on raise, no approval required.',
    v_now, 'not_required'
  ) returning * into r;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'change_request.create', 'change_request', r.id, null, to_jsonb(r),
            p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_principal_id);

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'change_request.emergency_commit', 'change_request', r.id, null,
            jsonb_build_object('emergency', true, 'tier', 'emergency', 'status', r.status, 'approval_required', false, 'reference_id', r.reference_id),
            p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_principal_id);

  return to_jsonb(r);
end;
$$;

revoke execute on function nopm_raise_emergency_change_request(uuid, jsonb, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_raise_emergency_change_request(uuid, jsonb, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

-- == 9. the data steps, re-runnable (review C2-07) ==
-- Each step selects only rows that still need it, so calling the function again changes nothing once they are
-- done. It runs once at the end of this file. If an old build keeps serving after the migration and raises an
-- emergency in the old shape, run  select nopm_apply_tier_decisions();  again (see CUTOVER) to retire it.
--   a. Q1: an emergency still waiting for a retro decision is closed out ('retired'); status emergency -> approved.
--   b. Q5: a pending expense deletion at or above the threshold becomes high_risk; an assignee who is not an admin
--      is cleared (a manager could no longer decide it), and the audit row says so.
--   c. Q4: a pending deletion of an APPROVED document raised under the old rule (high_risk) goes back to normal.

create or replace function nopm_apply_tier_decisions()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r         record;
  v_after   change_requests%rowtype;
  v_retired int := 0;
  v_raised  int := 0;
  v_lowered int := 0;
  v_cleared uuid;
begin
  -- a. Q1
  for r in
    select * from change_requests
     where is_emergency and retro_decided_at is null
     order by created_at, id
     for update
  loop
    update change_requests set
      status             = case when r.status = 'emergency' then 'approved' else r.status end,
      decided_at         = case when r.status = 'emergency' then coalesce(r.decided_at, now()) else r.decided_at end,
      decision_rationale = case when r.status = 'emergency'
                                then coalesce(r.decision_rationale, 'Emergency: committed, no approval required')
                                else r.decision_rationale end,
      retro_decided_at   = now(),
      retro_outcome      = 'retired'
    where id = r.id
    returning * into v_after;

    insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after)
      values (r.workspace_id, 'user'::actor_type, null, 'system (migration 0106)',
              'change_request.retro_retired', 'change_request', r.id,
              jsonb_build_object('status', r.status, 'tier', r.tier, 'is_emergency', r.is_emergency, 'retro_due_at', r.retro_due_at, 'retro_decided_at', r.retro_decided_at),
              jsonb_build_object('status', v_after.status, 'tier', v_after.tier, 'is_emergency', v_after.is_emergency, 'retro_decided_at', v_after.retro_decided_at,
                                 'retro_outcome', v_after.retro_outcome,
                                 'reason', 'The retro approval requirement was retired: an emergency change is a flag only and needs no approval.'));
    v_retired := v_retired + 1;
  end loop;

  -- b. Q5
  for r in
    select d.id, d.workspace_id, d.assigned_approver_id, abs(coalesce(e.amount, 0)) as amount
      from deletion_requests d
      join expenses e on e.id = d.target_id and e.workspace_id = d.workspace_id
      join workspaces w on w.id = d.workspace_id
     where d.target_type = 'expense'
       and d.status::text = 'pending'
       and d.tier = 'normal'
       and abs(coalesce(e.amount, 0)) <> 0
       and abs(coalesce(e.amount, 0)) >= coalesce((w.approval_policy ->> 'currency_threshold')::numeric, 50000)
     order by d.created_at, d.id
     for update of d
  loop
    v_cleared := null;
    if r.assigned_approver_id is not null
       and not exists (select 1 from profiles p where p.id = r.assigned_approver_id and p.workspace_id = r.workspace_id and p.role = 'admin') then
      v_cleared := r.assigned_approver_id;
    end if;
    update deletion_requests
       set tier = 'high_risk',
           assigned_approver_id = case when v_cleared is not null then null else assigned_approver_id end
     where id = r.id;
    insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after)
      values (r.workspace_id, 'user'::actor_type, null, 'system (migration 0106)',
              'deletion_request.tier_raised', 'deletion_request', r.id,
              jsonb_build_object('tier', 'normal', 'assigned_approver_id', r.assigned_approver_id),
              jsonb_build_object('tier', 'high_risk', 'amount', r.amount,
                                 'cleared_assigned_approver', v_cleared,
                                 'reason', 'An expense deletion at or above the currency threshold is high risk.'));
    v_raised := v_raised + 1;
  end loop;

  -- c. Q4
  for r in
    select d.id, d.workspace_id
      from deletion_requests d
      join documents x on x.id = d.target_id and x.workspace_id = d.workspace_id
     where d.target_type = 'document'
       and d.status::text = 'pending'
       and d.tier = 'high_risk'
       and x.status = 'approved'
     order by d.created_at, d.id
     for update of d
  loop
    update deletion_requests set tier = 'normal' where id = r.id;
    insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after)
      values (r.workspace_id, 'user'::actor_type, null, 'system (migration 0106)',
              'deletion_request.tier_lowered', 'deletion_request', r.id,
              jsonb_build_object('tier', 'high_risk'),
              jsonb_build_object('tier', 'normal',
                                 'reason', 'Deleting an approved document is on the manager tier; there is no admin gate.'));
    v_lowered := v_lowered + 1;
  end loop;

  return jsonb_build_object('emergency_retired', v_retired, 'expense_raised', v_raised, 'document_lowered', v_lowered);
end;
$$;

revoke execute on function nopm_apply_tier_decisions() from public, anon, authenticated;
grant  execute on function nopm_apply_tier_decisions() to service_role;

select nopm_apply_tier_decisions();

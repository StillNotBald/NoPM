-- NoPM · 0100 approval tiers (2026-10-18, audit gaps G1 G2 G4 G7, assumption A3).
--
-- THE GAP. Approval was a fixed two-step model: any manager or admin decides
-- anything. The brief asks for five tiers (routine, normal, high_risk, emergency,
-- strategic), a configurable approver role per tier, an emergency "ship now, approve
-- later" path with a retro deadline, and a currency threshold that raises a normal
-- request to high risk.
--
-- THE FIX (all additive).
--   1. workspaces.approval_policy jsonb, default '{}' (= every default of CR A3), with
--      its shape enforced by nopm_approval_policy_valid(jsonb): a tiers object keyed
--      by the five names, each {approver_role: manager|admin, turnaround_hours: int,
--      auto_approve: boolean (true only for routine)}, plus currency_threshold,
--      currency and emergency_retro_hours.
--   2. tier text + CHECK on change_requests, deletion_requests and rebaselines
--      (default 'normal'; a deletion of a PROJECT defaults to 'high_risk' via trigger),
--      and approval_deadline_at on all three.
--   3. change_requests gains the emergency path: is_emergency, retro_due_at,
--      retro_decided_at, retro_outcome. Status 'emergency' is a request raised as an
--      emergency: it can be implemented at once and still waits for a retro decision.
--      (change_requests.status is plain text with no value list, so there is no CHECK to
--      extend; the new CHECKs tie the status to the flag instead.)
--   4. The 0092 CHECK cr_implemented_after_decision is relaxed for emergencies (go-live
--      may come BEFORE the retro decision; it must still not precede the raise) and a
--      new CHECK says status 'implemented' needs a decision, or the emergency flag.
--      cr_maker_checker is widened so an emergency request with no decider yet is legal.
--   5. DB backstop of the approver role: nopm_tier_required_role / nopm_principal_meets_tier
--      read the policy; triggers on change_requests, deletion_requests (replaces the 0061
--      function body, same trigger) and rebaseline_signoffs refuse a decider whose role is
--      below the tier's (P0018 ROLE_NOT_PERMITTED, already mapped to 403). A BEFORE trigger on
--      change_requests also raises the tier (never lowers it): a cost at or above the currency
--      threshold turns normal into high_risk, money or dates on a routine request turn it
--      normal. So editing the cost of a pending request cannot dodge the routing.
--   6. nopm_decide_change_request and nopm_implement_change_request are recreated with the
--      SAME signatures (one overload each): decide accepts 'emergency' (and a live emergency
--      still awaiting its retro decision), checks the tier role, and stamps the retro columns;
--      implement accepts an emergency request.
--
-- SQLSTATES taken by this migration and 0101 (each used for one meaning repo-wide, W4-10): P0030 TIER_LOCKED,
-- P0031 AUTO_APPROVE_OFF, P0032 NOT_ROUTINE, P0033 NOT_DUE, P0034 STALE_ROW and P0035 FORBIDDEN_COLUMN (0101 settings RPC). P0018 ROLE_NOT_PERMITTED is the existing
-- role refusal and keeps its code.
--
-- Fallback approver (owner decision D7, W4-07): a workspace with fewer than two admins cannot give an
-- admin-tier request a second human, so a MANAGER may then decide it. nopm_principal_meets_tier says
-- yes in that case, and nopm_decide_change_request marks its audit row "fallback_approver": true.
--
-- NOT VALID + VALIDATE in skip blocks, so a surprise legacy row can never abort the release.
-- No backfill and no updated_at bump: an approver's pinned version (expected_updated_at) of a
-- request raised before this migration stays valid. Existing rows read as tier 'normal'.
-- ROLLBACK: drop triggers trg_cr_tier_guard, trg_signoff_tier_role, trg_deletion_tier_default;
-- re-apply the 0061 / 0072 / 0092 function bodies; drop the new columns, constraints and functions.

-- == 1. policy shape ==

create or replace function nopm_approval_policy_valid(p jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  k text;
  t text;
  v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('tiers', 'currency_threshold', 'currency', 'emergency_retro_hours', 'schedule_threshold_days') then
      return false;
    end if;
  end loop;

  if p ? 'tiers' then
    if jsonb_typeof(p -> 'tiers') <> 'object' then
      return false;
    end if;
    for t in select jsonb_object_keys(p -> 'tiers') loop
      if t not in ('routine', 'normal', 'high_risk', 'emergency', 'strategic') then
        return false;
      end if;
      v := p -> 'tiers' -> t;
      if jsonb_typeof(v) <> 'object' then
        return false;
      end if;
      for k in select jsonb_object_keys(v) loop
        if k not in ('approver_role', 'turnaround_hours', 'auto_approve') then
          return false;
        end if;
      end loop;
      if v ? 'approver_role' then
        if jsonb_typeof(v -> 'approver_role') <> 'string' or (v ->> 'approver_role') not in ('manager', 'admin') then
          return false;
        end if;
      end if;
      if v ? 'turnaround_hours' then
        if jsonb_typeof(v -> 'turnaround_hours') <> 'number'
           or (v ->> 'turnaround_hours')::numeric <> trunc((v ->> 'turnaround_hours')::numeric)
           or (v ->> 'turnaround_hours')::numeric < 0
           or (v ->> 'turnaround_hours')::numeric > 8760 then
          return false;
        end if;
      end if;
      if v ? 'auto_approve' then
        if jsonb_typeof(v -> 'auto_approve') <> 'boolean' then
          return false;
        end if;
        -- Auto-approve exists for the routine tier only (CR A1).
        if (v ->> 'auto_approve')::boolean and t <> 'routine' then
          return false;
        end if;
      end if;
    end loop;
  end if;

  if p ? 'currency_threshold' then
    if jsonb_typeof(p -> 'currency_threshold') <> 'number' or (p ->> 'currency_threshold')::numeric < 0 then
      return false;
    end if;
  end if;
  if p ? 'currency' then
    if jsonb_typeof(p -> 'currency') <> 'string' or char_length(p ->> 'currency') <> 3 then
      return false;
    end if;
  end if;
  if p ? 'schedule_threshold_days' then
    if jsonb_typeof(p -> 'schedule_threshold_days') <> 'number'
       or (p ->> 'schedule_threshold_days')::numeric <> trunc((p ->> 'schedule_threshold_days')::numeric)
       or (p ->> 'schedule_threshold_days')::numeric < 0
       or (p ->> 'schedule_threshold_days')::numeric > 3650 then
      return false;
    end if;
  end if;
  if p ? 'emergency_retro_hours' then
    if jsonb_typeof(p -> 'emergency_retro_hours') <> 'number'
       or (p ->> 'emergency_retro_hours')::numeric <> trunc((p ->> 'emergency_retro_hours')::numeric)
       or (p ->> 'emergency_retro_hours')::numeric < 1
       or (p ->> 'emergency_retro_hours')::numeric > 720 then
      return false;
    end if;
  end if;
  return true;
end;
$$;

alter table workspaces
  add column if not exists approval_policy jsonb not null default '{}'::jsonb;

comment on column workspaces.approval_policy is
  'Approval tiers (CR A3): {tiers:{routine|normal|high_risk|emergency|strategic:{approver_role,turnaround_hours,auto_approve}}, currency_threshold, currency, emergency_retro_hours}. {} = every default. Shape: nopm_approval_policy_valid.';

-- == 2/3. tier + deadline columns, emergency columns ==

alter table change_requests
  add column if not exists tier                 text        not null default 'normal',
  add column if not exists approval_deadline_at timestamptz,
  add column if not exists is_emergency         boolean     not null default false,
  add column if not exists retro_due_at         timestamptz,
  add column if not exists retro_decided_at     timestamptz,
  add column if not exists retro_outcome        text;

alter table deletion_requests
  add column if not exists tier                 text        not null default 'normal',
  add column if not exists approval_deadline_at timestamptz;

alter table rebaselines
  add column if not exists tier                 text        not null default 'normal',
  add column if not exists approval_deadline_at timestamptz;

comment on column change_requests.tier is 'approval tier: routine | normal | high_risk | emergency | strategic (set at raise; only ever raised afterwards)';
comment on column change_requests.approval_deadline_at is 'raise time + the tier turnaround hours at that moment; NULL = no turnaround set';
comment on column change_requests.is_emergency is 'raised on the emergency path: implementable at once, retro decision due by retro_due_at';
comment on column change_requests.retro_due_at is 'when the after-the-fact (retro) decision on an emergency request is due';
comment on column change_requests.retro_decided_at is 'when the retro decision was taken; NULL while an emergency request is still flagged';
comment on column change_requests.retro_outcome is 'the retro decision: approved | rejected | deferred';
comment on column deletion_requests.tier is 'approval tier (a project deletion defaults to high_risk)';
comment on column rebaselines.tier is 'approval tier';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_approval_policy_valid') then
    alter table workspaces
      add constraint workspaces_approval_policy_valid
      check (nopm_approval_policy_valid(approval_policy)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cr_tier_values') then
    alter table change_requests
      add constraint cr_tier_values
      check (tier in ('routine', 'normal', 'high_risk', 'emergency', 'strategic')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dr_tier_values') then
    alter table deletion_requests
      add constraint dr_tier_values
      check (tier in ('routine', 'normal', 'high_risk', 'emergency', 'strategic')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rb_tier_values') then
    alter table rebaselines
      add constraint rb_tier_values
      check (tier in ('routine', 'normal', 'high_risk', 'emergency', 'strategic')) not valid;
  end if;
  -- The emergency flag and the emergency tier are the same fact.
  if not exists (select 1 from pg_constraint where conname = 'cr_emergency_shape') then
    alter table change_requests
      add constraint cr_emergency_shape
      check (
        is_emergency = (tier = 'emergency')
        and (status <> 'emergency' or is_emergency)
        and (not is_emergency or retro_due_at is not null)
        and (retro_outcome is null or (retro_outcome in ('approved', 'rejected', 'deferred') and is_emergency))
        and ((retro_outcome is null) = (retro_decided_at is null))
      ) not valid;
  end if;
  -- 'implemented' needs a decision, or the emergency flag (the retro decision follows).
  if not exists (select 1 from pg_constraint where conname = 'cr_implemented_needs_decision') then
    alter table change_requests
      add constraint cr_implemented_needs_decision
      check (status <> 'implemented' or decided_at is not null or is_emergency) not valid;
  end if;
end $$;

-- cr_maker_checker (0043 form) + the emergency case: an emergency request that is still
-- 'emergency' or already 'implemented' may have no decider yet; the retro decider is then
-- held to the same different-human rule as every other decision.
alter table change_requests drop constraint if exists cr_maker_checker;
alter table change_requests
  add constraint cr_maker_checker check (
    status in ('raised', 'under_review')
    or (is_emergency and status in ('emergency', 'implemented') and decided_by_id is null)
    or (
      decided_by_id is not null
      and (
        requested_by_id is null
        or decided_by_id <> requested_by_id
        or decided_by_type <> requested_by_type
      )
    )
  ) not valid;

-- cr_implemented_after_decision (0092) relaxed: an emergency request goes live BEFORE its
-- retro decision, so it is compared with the raise time instead.
alter table change_requests drop constraint if exists cr_implemented_after_decision;
alter table change_requests
  add constraint cr_implemented_after_decision
  check (
    implemented_at is null
    or (is_emergency and implemented_at >= raised_at)
    or (decided_at is not null and implemented_at >= decided_at)
  ) not valid;

do $$
declare c text;
begin
  foreach c in array array[
    'workspaces:workspaces_approval_policy_valid',
    'change_requests:cr_tier_values',
    'deletion_requests:dr_tier_values',
    'rebaselines:rb_tier_values',
    'change_requests:cr_emergency_shape',
    'change_requests:cr_implemented_needs_decision',
    'change_requests:cr_maker_checker',
    'change_requests:cr_implemented_after_decision'
  ] loop
    begin
      execute format('alter table %I validate constraint %I', split_part(c, ':', 1), split_part(c, ':', 2));
    exception when others then
      raise notice '0100: % left NOT VALID (%)', split_part(c, ':', 2), sqlerrm;
    end;
  end loop;
end $$;

create index if not exists change_requests_retro_open_idx
  on change_requests (workspace_id, retro_due_at)
  where is_emergency and retro_decided_at is null;

-- == 5. role lookup + backstop triggers ==

-- The role the policy asks of a tier's decider. A workspace with no policy gets the CR A3 defaults:
-- routine and normal -> manager, high_risk / emergency (retro) / strategic -> admin.
create or replace function nopm_tier_required_role(p_workspace_id uuid, p_tier text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif((select w.approval_policy #>> array['tiers', p_tier, 'approver_role'] from workspaces w where w.id = p_workspace_id), ''),
    case when p_tier in ('high_risk', 'emergency', 'strategic') then 'admin' else 'manager' end
  );
$$;

-- Fallback approver (D7): a workspace with fewer than two admins has nobody to be the second human
-- for an admin-tier request, so a manager may decide it.
create or replace function nopm_admin_fallback_open(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (select count(*) from profiles where workspace_id = p_workspace_id and role = 'admin') < 2;
$$;

-- True when the person is a profile of the workspace whose role meets the tier:
-- an admin meets every tier, a manager meets those that ask for a manager, or any tier while the
-- workspace has fewer than two admins (D7).
create or replace function nopm_principal_meets_tier(p_workspace_id uuid, p_tier text, p_principal uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
     where id = p_principal
       and workspace_id = p_workspace_id
       and (
         role = 'admin'
         or (role = 'manager' and (nopm_tier_required_role(p_workspace_id, p_tier) = 'manager' or nopm_admin_fallback_open(p_workspace_id)))
       )
  );
$$;

-- True when this decider passes ONLY because of the fallback (a manager on an admin-tier request).
create or replace function nopm_principal_uses_fallback(p_workspace_id uuid, p_tier text, p_principal uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from profiles where id = p_principal and workspace_id = p_workspace_id and role = 'manager')
     and nopm_tier_required_role(p_workspace_id, p_tier) = 'admin'
     and nopm_admin_fallback_open(p_workspace_id);
$$;

revoke execute on function nopm_tier_required_role(uuid, text) from public, anon, authenticated;
revoke execute on function nopm_principal_meets_tier(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function nopm_admin_fallback_open(uuid) from public, anon, authenticated;
revoke execute on function nopm_principal_uses_fallback(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function nopm_tier_required_role(uuid, text) to service_role;
grant  execute on function nopm_principal_meets_tier(uuid, text, uuid) to service_role;
grant  execute on function nopm_admin_fallback_open(uuid) to service_role;
grant  execute on function nopm_principal_uses_fallback(uuid, text, uuid) to service_role;

-- Rank used to make a tier only ever go UP after the raise (emergency stands alone).
create or replace function nopm_tier_rank(p_tier text)
returns int
language sql
immutable
as $$
  select case p_tier when 'routine' then 1 when 'normal' then 2 when 'high_risk' then 3 when 'strategic' then 4 else null end;
$$;

-- change_requests: tier can only rise; a cost at/over the threshold lifts normal to high_risk;
-- money or dates on a routine request make it normal; a new decider must meet the tier's role.
create or replace function nopm_cr_tier_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_policy     jsonb;
  v_threshold  numeric;
  v_days_limit numeric;
  v_money      boolean;
  v_dates      boolean;
  v_changed    boolean := (tg_op = 'INSERT');
begin
  -- OLD does not exist on INSERT and SQL does not short-circuit, so it is read only on UPDATE.
  if tg_op = 'UPDATE' then
    v_changed := new.impact_cost is distinct from old.impact_cost
              or new.impact_schedule_days is distinct from old.impact_schedule_days
              or new.impact_scope is distinct from old.impact_scope;
  end if;

  if new.tier <> 'emergency' and v_changed then
    v_money := coalesce(new.impact_cost, 0) <> 0;
    v_dates := coalesce(new.impact_schedule_days, 0) <> 0;

    -- A routine request carries no money, no dates and no structured scope impact.
    if new.tier = 'routine'
       and (v_money or v_dates or (new.impact_scope is not null and jsonb_array_length(new.impact_scope) > 0)) then
      new.tier := 'normal';
    end if;

    if new.tier = 'normal' then
      select approval_policy into v_policy from workspaces where id = new.workspace_id;
      -- Amounts are compared as plain numbers in the workspace's own currency (the policy currency is a label).
      v_threshold := coalesce((v_policy ->> 'currency_threshold')::numeric, 50000);
      v_days_limit := coalesce((v_policy ->> 'schedule_threshold_days')::numeric, 10);
      if (v_money and abs(new.impact_cost) >= v_threshold) or abs(coalesce(new.impact_schedule_days, 0)) > v_days_limit then
        new.tier := 'high_risk';
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.tier is distinct from old.tier then
      if nopm_tier_rank(new.tier) is null or nopm_tier_rank(old.tier) is null or nopm_tier_rank(new.tier) < nopm_tier_rank(old.tier) then
        raise exception 'TIER_LOCKED: a request''s approval tier can only be raised' using errcode = 'P0030';
      end if;
    end if;
    if new.decided_principal_id is not null
       and new.decided_principal_id is distinct from old.decided_principal_id
       and not nopm_principal_meets_tier(new.workspace_id, new.tier, new.decided_principal_id) then
      raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(new.workspace_id, new.tier), new.tier using errcode = 'P0018';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_cr_tier_guard() from public, anon, authenticated;
grant  execute on function nopm_cr_tier_guard() to service_role;

drop trigger if exists trg_cr_tier_guard on change_requests;
create trigger trg_cr_tier_guard
  before insert or update on change_requests
  for each row execute function nopm_cr_tier_guard();

-- deletion_requests: the 0061 function, now tier-aware (same function, same trigger).
create or replace function nopm_deletion_approver_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status::text = 'pending'
     and new.status::text in ('committed', 'approved', 'rejected')
     and new.approved_principal_id is not null then
    if not nopm_principal_meets_tier(new.workspace_id, new.tier, new.approved_principal_id) then
      raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(new.workspace_id, new.tier), new.tier using errcode = 'P0018';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_deletion_approver_role() from public, anon, authenticated;
grant  execute on function nopm_deletion_approver_role() to service_role;

-- A deletion of a whole project is high risk unless the raiser said otherwise on purpose.
create or replace function nopm_deletion_tier_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.target_type = 'project' and new.tier = 'normal' then
    new.tier := 'high_risk';
  end if;
  return new;
end;
$$;

revoke execute on function nopm_deletion_tier_default() from public, anon, authenticated;
grant  execute on function nopm_deletion_tier_default() to service_role;

drop trigger if exists trg_deletion_tier_default on deletion_requests;
create trigger trg_deletion_tier_default
  before insert on deletion_requests
  for each row execute function nopm_deletion_tier_default();

-- rebaselines: a sign-off vote is the decision; its caster must meet the rebaseline's tier.
create or replace function nopm_signoff_tier_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text;
begin
  if new.vote::text in ('go', 'no_go') then
    select tier into v_tier from rebaselines where id = new.rebaseline_id;
    if v_tier is not null
       and not nopm_principal_meets_tier(new.workspace_id, v_tier, coalesce(new.approver_principal_id, new.approver_id)) then
      raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(new.workspace_id, v_tier), v_tier using errcode = 'P0018';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_signoff_tier_role() from public, anon, authenticated;
grant  execute on function nopm_signoff_tier_role() to service_role;

drop trigger if exists trg_signoff_tier_role on rebaseline_signoffs;
create trigger trg_signoff_tier_role
  before insert or update on rebaseline_signoffs
  for each row execute function nopm_signoff_tier_role();

-- == 6. nopm_decide_change_request (from 20261017000072): emergency + tier role + retro stamp ==

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
  -- A live emergency request (already implemented) is still waiting for its retro decision.
  if not (
       cr.status in ('raised', 'under_review', 'emergency')
    or (cr.status = 'implemented' and cr.is_emergency and cr.retro_decided_at is null)
  ) then
    raise exception 'ALREADY_DECIDED: status is %', cr.status using errcode = 'P0001';
  end if;
  -- G1/G2: the tier names the role that decides.
  if not nopm_principal_meets_tier(p_workspace_id, cr.tier, p_approver_principal_id) then
    raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(p_workspace_id, cr.tier), cr.tier using errcode = 'P0018';
  end if;
  -- A change that is already live cannot be deferred: it is approved or rejected after the fact.
  if cr.status = 'implemented' and p_new_status = 'deferred' then
    raise exception 'INVALID_STATUS: a live emergency change is approved or rejected, not deferred' using errcode = 'P0001';
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
    status               = case when cr.status = 'implemented' then 'implemented' else p_new_status end,
    decided_by           = case when p_actor_type = 'user' then p_actor_id else null end,
    decided_by_label     = p_actor_label,
    decided_by_type      = p_actor_type::actor_type,
    decided_by_id        = p_actor_id,
    decided_principal_id = p_approver_principal_id,
    decision_rationale   = p_rationale,
    decided_at           = now(),
    retro_decided_at     = case when cr.is_emergency then now() else retro_decided_at end,
    retro_outcome        = case when cr.is_emergency then p_new_status else retro_outcome end
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

-- == 6b. nopm_implement_change_request (from 20261018000092): an emergency request can go live at once ==

create or replace function nopm_implement_change_request(
  p_id                 uuid,
  p_workspace_id       uuid,
  p_note               text,
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
  cr      change_requests%rowtype;
  v_after change_requests%rowtype;
  v_role  text;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if p_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;

  select role::text into v_role from profiles
    where id = p_principal_id and workspace_id = p_workspace_id;

  select * into cr from change_requests
    where id = p_id and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Who first (a stranger learns nothing about the status), then the state.
  if not (
       (v_role is not null and v_role in ('admin', 'manager'))
    or (cr.requested_principal_id is not null and cr.requested_principal_id = p_principal_id)
  ) then
    raise exception 'NOT_ALLOWED: only the requester or a manager or admin can mark this implemented' using errcode = 'P0023';
  end if;

  if cr.status = 'implemented' then
    raise exception 'ALREADY_IMPLEMENTED' using errcode = 'P0028';
  end if;
  -- G4: an emergency request is implementable before any decision; every other one needs 'approved'.
  if not (cr.status = 'approved' or (cr.status = 'emergency' and cr.is_emergency)) then
    raise exception 'INVALID_TRANSITION: status is %', cr.status using errcode = 'P0024';
  end if;
  update change_requests set
    status                   = 'implemented',
    implemented_at           = now(),
    implemented_by           = case when p_actor_type = 'user' then p_actor_id else null end,
    implemented_by_type      = p_actor_type::actor_type,
    implemented_by_id        = p_actor_id,
    implemented_by_label     = p_actor_label,
    implemented_principal_id = p_principal_id,
    implemented_note         = nullif(btrim(p_note), '')
  where id = p_id and workspace_id = p_workspace_id
  returning * into v_after;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'change_request.implement', 'change_request', p_id,
            to_jsonb(cr), to_jsonb(v_after),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_principal_id);

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_implement_change_request(uuid, uuid, text, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_implement_change_request(uuid, uuid, text, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

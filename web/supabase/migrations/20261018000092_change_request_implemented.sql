-- NoPM · 0092 change_request_implemented (2026-10-18, audit gaps M2 + B2, assumption A2).
--
-- THE GAP (M2). A change request proved it was APPROVED (decided_at, decided_by*,
-- decided_principal_id) but not that it was approved BEFORE it went live: status
-- 'implemented' was read in three places (the budget route, project-children,
-- migration 0076) yet nothing ever set it, and no column held a go-live time.
--
-- THE FIX.
--   1. Additive columns on change_requests: implemented_at, implemented_by (the
--      profile, users only, like decided_by), implemented_by_type, implemented_by_id
--      (the actor, token or user), implemented_by_label, implemented_principal_id
--      (the HUMAN behind the actor) and implemented_note.
--   2. CHECK cr_implemented_after_decision: implemented_at is null OR
--      (decided_at is not null AND implemented_at >= decided_at). The order
--      "approved, then live" is now a database fact.
--   3. CHECK cr_implemented_status_stamp: status = 'implemented' implies
--      implemented_at is not null. Both are added NOT VALID (enforced for every
--      new write at once) and then validated in a skip-on-failure block, so a
--      surprise legacy row can never abort the release. No existing row has the
--      status 'implemented' (nothing ever set it), so validation is expected to pass.
--   4. nopm_implement_change_request (new): ONE transaction moves an APPROVED
--      request to 'implemented', stamps the columns and writes the audit row
--      change_request.implement. Who may: the requester's person, or a manager or
--      admin. Errcodes: P0005 INVALID_CHANNEL, P0006 NO_PRINCIPAL, P0002 NOT_FOUND,
--      P0023 NOT_REQUESTER, P0028 ALREADY_IMPLEMENTED (new, unused before),
--      P0024 INVALID_TRANSITION (not approved).
--
-- B2 (structured scope impact): change_requests.impact_scope jsonb, an array of
-- {area, direction, note}. area = scope|schedule|cost|quality|resources|compliance,
-- direction = increase|decrease|neutral. The free-text impact_summary stays. Shape
-- is validated by the API (zod); the database only insists it is an array.
--
-- No backfill, so no updated_at trigger is paused. Idempotent and additive.
-- ROLLBACK: drop function nopm_implement_change_request(...); alter table
-- change_requests drop constraint cr_implemented_after_decision, drop constraint
-- cr_implemented_status_stamp, drop constraint cr_impact_scope_array, then drop
-- the new columns.

alter table change_requests
  add column if not exists implemented_at           timestamptz,
  add column if not exists implemented_by           uuid references profiles(id),
  add column if not exists implemented_by_type      actor_type,
  add column if not exists implemented_by_id        uuid,
  add column if not exists implemented_by_label     text,
  add column if not exists implemented_principal_id uuid,
  add column if not exists implemented_note         text,
  add column if not exists impact_scope             jsonb;

comment on column change_requests.implemented_at is 'when the approved change went live (set only by nopm_implement_change_request); never earlier than decided_at';
comment on column change_requests.implemented_by is 'profile of the user who marked it implemented; NULL when a token did (see implemented_principal_id)';
comment on column change_requests.implemented_by_id is 'id of the actor (profile or api token) that marked it implemented. No FK on purpose: evidence that survives deletion.';
comment on column change_requests.implemented_principal_id is 'the HUMAN behind the actor that marked it implemented';
comment on column change_requests.impact_scope is 'structured impact: array of {area: scope|schedule|cost|quality|resources|compliance, direction: increase|decrease|neutral, note}. impact_summary stays the free-text companion.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cr_impact_scope_array') then
    alter table change_requests
      add constraint cr_impact_scope_array
      check (impact_scope is null or jsonb_typeof(impact_scope) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cr_implemented_after_decision') then
    alter table change_requests
      add constraint cr_implemented_after_decision
      check (implemented_at is null or (decided_at is not null and implemented_at >= decided_at))
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cr_implemented_status_stamp') then
    alter table change_requests
      add constraint cr_implemented_status_stamp
      check (status <> 'implemented' or implemented_at is not null)
      not valid;
  end if;
end $$;

-- Validate after the (empty) backfill; a failure only skips, it never blocks the release.
do $$
begin
  begin
    alter table change_requests validate constraint cr_implemented_after_decision;
  exception when others then
    raise notice '0092: cr_implemented_after_decision left NOT VALID (%)', sqlerrm;
  end;
  begin
    alter table change_requests validate constraint cr_implemented_status_stamp;
  exception when others then
    raise notice '0092: cr_implemented_status_stamp left NOT VALID (%)', sqlerrm;
  end;
end $$;

-- == nopm_implement_change_request (new) ==

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
    -- A request with no recorded requester principal can only be implemented by an approver role.
    raise exception 'NOT_ALLOWED: only the requester or a manager or admin can mark this implemented' using errcode = 'P0023';
  end if;

  -- A second tap, or a second person, finds it already stamped: never re-stamped.
  if cr.status = 'implemented' then
    raise exception 'ALREADY_IMPLEMENTED' using errcode = 'P0028';
  end if;
  if cr.status <> 'approved' then
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

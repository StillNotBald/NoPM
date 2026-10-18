-- NoPM · 0108 (2026-10-18) — governance writes and their audit rows in ONE transaction (M1 close-out, W5-A).
--
-- ROLLBACK. drop function if exists nopm_request_deletion(uuid, text, uuid, text, uuid, text, timestamptz, text, uuid, text, uuid, jsonb, jsonb);
--           drop function if exists nopm_withdraw_deletion_request(uuid, uuid, text, jsonb);
--           drop function if exists nopm_reject_deletion_request(uuid, uuid, text, uuid, text, uuid, text, jsonb);
--           drop function if exists nopm_raise_change_request(uuid, jsonb, text, timestamptz, uuid, uuid, jsonb, jsonb);
--           drop function if exists nopm_edit_change_request(uuid, uuid, jsonb, uuid, jsonb);
--           drop function if exists nopm_withdraw_change_request(uuid, uuid, uuid, jsonb);
--           drop function if exists nopm_propose_rebaseline(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid, jsonb, jsonb, jsonb);
--           drop table if exists nopm_deletion_entities;
--
-- WHY. Until now the deletion maker step (project, task and the five records of 0102), the change-request
-- raise, edit and withdraw, the rebaseline proposal and the withdraw / reject of a deletion request wrote the
-- change first and the audit row second, in two round trips. A crash between them left a change with no trail
-- (audit finding M1, "an audit row is written together with the change"). The withdraw and reject paths even
-- carried compensating code that put the status back when the audit failed. Each function below does the write
-- AND its audit row in one transaction, through the shared helper nopm_audit_insert (0107).
--
-- WHAT STAYS IN THE APP. Who may do what is decided before the call and is unchanged: scopes, the maker
-- principal, the tier from the approval policy (classify), the assigned approver, the project-lock pre-checks and
-- the approved-records refusal (with their "blocked" audit rows), four-eyes comparisons and the approval notices.
-- The functions repeat the rules that a race could slip past (target still there, project still unlocked, request
-- still pending, change request still open and still the requester's) and let the existing triggers and unique
-- indexes (uniq_pending_deletion, uniq_pending_rebaseline, tier guards, approver-role trigger) do the rest.
--
-- ONE AUDIT ROW PER BUSINESS WRITE. Every function writes exactly the audit row the route wrote before (same action,
-- same target type, same before / after). nopm_raise_emergency_change_request (0106) is untouched.
--
-- nopm_deletion_entities. The one place that says which table a deletion request points at, which commit RPC
-- approves it, and how the approver's scope count is taken. Wave 2 adds an entity with an INSERT into this table
-- and never rewrites nopm_request_deletion. child_count_sql is a statement written by a migration (never by a
-- caller): it takes $1 = workspace id, $2 = target id and returns jsonb that is stored as before.child_counts.
--
-- ERRORS (all P-codes raised as before where one existed): P0002 NOT_FOUND, P0001 ALREADY_DECIDED / CR_DECIDED,
-- P0006 NO_PRINCIPAL, P0010 PROJECT_LOCKED, P0019 PROJECT_NOT_LOCKED, P0023 NOT_REQUESTER, P0059 INVALID_AUDIT,
-- P0060 UNSUPPORTED_ENTITY, P0061 EMERGENCY_VIA_OTHER_FUNCTION. A duplicate pending deletion or rebaseline is the
-- unique violation 23505 from the existing index; the route maps it exactly as it did.
--
-- P0064 INVALID_ASSIGNEE: an assigned approver that is not a profile of the workspace (checked inside the transaction).
--
-- SAFETY. Additive: one new table (seeded), seven new functions, nothing altered. Safe on live rows at ledger
-- 0107 and safe to re-run (if not exists, create or replace, on conflict do nothing). Service role only; security
-- definer with search_path pinned to public; every statement filters by the workspace id parameter.
-- ORDER OF APPLY. After 0107 (the helper), before the build that calls these functions.

-- == 1. the entity map ==========================================================================================

create table if not exists nopm_deletion_entities (
  entity          text primary key,
  table_name      text not null,
  commit_rpc      text not null,
  child_count_sql text
);

alter table nopm_deletion_entities enable row level security;
revoke all on nopm_deletion_entities from public, anon, authenticated;
-- Read-only for the service role: child_count_sql runs as dynamic SQL, so only migrations (the owner) may change it.
revoke insert, update, delete, truncate on nopm_deletion_entities from service_role;
grant select on nopm_deletion_entities to service_role;

comment on table nopm_deletion_entities is
  'Wave 5: which table, commit RPC and child-count statement belong to each deletion_requests.target_type. Add an entity with an INSERT; nopm_request_deletion reads this table.';

insert into nopm_deletion_entities (entity, table_name, commit_rpc, child_count_sql) values
  ('task',      'tasks',      'nopm_commit_task_deletion',      null),
  ('project',   'projects',   'nopm_commit_project_deletion',   'select nopm_project_child_counts($2)'),
  ('risk',      'risks',      'nopm_commit_risk_deletion',      null),
  ('issue',     'issues',     'nopm_commit_issue_deletion',     null),
  ('expense',   'expenses',   'nopm_commit_expense_deletion',   null),
  ('document',  'documents',  'nopm_commit_document_deletion',  null),
  ('milestone', 'milestones', 'nopm_commit_milestone_deletion',
     'select jsonb_build_object(''tasks'', count(*)) from tasks where workspace_id = $1 and milestone_id = $2')
on conflict (entity) do nothing;

-- == 2. a deletion request (maker step) ========================================================================
-- Inserts the deletion_requests row, its <entity>.delete_requested audit row and the deadline_set ledger event
-- together. The snapshot (`before`) is the target row read under a key-share lock in THIS transaction, plus
-- before.child_counts when the entity has a child_count_sql, so the approver always signs off the scope that
-- existed when the request was stored. Returns the new deletion_requests row as jsonb.

create or replace function nopm_request_deletion(
  p_workspace_id          uuid,
  p_entity                text,
  p_target_id             uuid,
  p_reason                text,
  p_assigned_approver_id  uuid,
  p_tier                  text,
  p_deadline              timestamptz,
  p_requested_by_type     text,
  p_requested_by_id       uuid,
  p_requested_by_label    text,
  p_requested_principal_id uuid,
  p_event_detail          jsonb,
  p_audit                 jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ent       nopm_deletion_entities%rowtype;
  v_row     jsonb;
  v_counts  jsonb;
  v_before  jsonb;
  v_project uuid;
  v_locked  boolean;
  d         deletion_requests%rowtype;
begin
  if p_requested_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;
  if p_audit is null or (p_audit ->> 'action') is distinct from (p_entity || '.delete_requested') then
    raise exception 'INVALID_AUDIT: action must be %.delete_requested', p_entity using errcode = 'P0059';
  end if;

  if p_assigned_approver_id is not null and not exists (select 1 from profiles where id = p_assigned_approver_id and workspace_id = p_workspace_id) then
    raise exception 'INVALID_ASSIGNEE' using errcode = 'P0064';
  end if;

  select * into ent from nopm_deletion_entities where entity = p_entity;
  if not found then
    raise exception 'UNSUPPORTED_ENTITY: %', p_entity using errcode = 'P0060';
  end if;

  -- The target, in this workspace, held against a concurrent delete until this transaction ends.
  execute format('select to_jsonb(t) from %I t where t.id = $1 and t.workspace_id = $2 for key share', ent.table_name)
    into v_row using p_target_id, p_workspace_id;
  if v_row is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Backstop for the route's lock pre-check: a project, task or milestone leaves the schedule, so a frozen
  -- baseline refuses the request even if the lock landed after the route looked.
  if p_entity in ('project', 'task', 'milestone') then
    v_project := case when p_entity = 'project' then p_target_id else nullif(v_row ->> 'project_id', '')::uuid end;
    if v_project is not null then
      select is_locked into v_locked from projects where id = v_project and workspace_id = p_workspace_id;
      if coalesce(v_locked, false) then
        raise exception 'PROJECT_LOCKED' using errcode = 'P0010';
      end if;
    end if;
  end if;

  v_before := v_row;
  if ent.child_count_sql is not null then
    execute ent.child_count_sql into v_counts using p_workspace_id, p_target_id;
    v_before := v_row || jsonb_build_object('child_counts', coalesce(v_counts, '{}'::jsonb));
  end if;

  insert into deletion_requests (
    workspace_id, target_type, target_id, reason, status, tier, approval_deadline_at,
    requested_by_type, requested_by_id, requested_by_label, requested_principal_id, before, assigned_approver_id
  ) values (
    p_workspace_id, p_entity, p_target_id, p_reason, 'pending', coalesce(p_tier, 'normal'), p_deadline,
    p_requested_by_type::actor_type, p_requested_by_id, p_requested_by_label, p_requested_principal_id, v_before,
    p_assigned_approver_id
  ) returning * into d;

  perform nopm_audit_insert(
    p_workspace_id, p_audit, p_target_id, v_before,
    case when p_assigned_approver_id is not null
         then jsonb_build_object('assigned_approver_id', p_assigned_approver_id) else null end);

  -- The ledger event is part of the transaction (one statement; the unique index makes a repeat a no-op).
  insert into approval_events (workspace_id, target_type, target_id, kind, actor_label, detail)
    values (p_workspace_id, 'deletion_request', d.id, 'deadline_set', p_audit ->> 'actor_label', p_event_detail)
    on conflict do nothing;

  return to_jsonb(d);
end;
$$;

-- == 3. withdraw a deletion request (the maker's own, or the system closing a doomed one) ======================
-- Pending -> withdrawn, compare-and-set under a row lock, with the audit row in the same transaction. p_closed_reason
-- is set only when the approval path closes a request whose target is gone or locked; then the audit `after`
-- carries it. Replaces the status update, the audit write and the compensating "put it back" code in decide.ts.

create or replace function nopm_withdraw_deletion_request(
  p_workspace_id  uuid,
  p_request_id    uuid,
  p_closed_reason text default null,
  p_audit         jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r deletion_requests%rowtype;
begin
  if p_audit is null or (p_audit ->> 'action') is distinct from 'deletion_request.withdrawn' then
    raise exception 'INVALID_AUDIT: action must be deletion_request.withdrawn' using errcode = 'P0059';
  end if;

  select * into r from deletion_requests where id = p_request_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception 'ALREADY_DECIDED' using errcode = 'P0001';
  end if;

  update deletion_requests
     set status = 'withdrawn',
         decided_at = now(),
         closed_reason = coalesce(p_closed_reason, closed_reason)
   where id = p_request_id and workspace_id = p_workspace_id
   returning * into r;

  perform nopm_audit_insert(
    p_workspace_id, p_audit, r.id,
    jsonb_build_object('status', 'pending'),
    case when p_closed_reason is null
         then jsonb_build_object('status', 'withdrawn')
         else jsonb_build_object('status', 'withdrawn', 'reason', p_closed_reason) end);

  return jsonb_build_object('id', r.id, 'status', r.status);
end;
$$;

-- == 4. reject a deletion request (the checker's "no") ==========================================================
-- Pending -> rejected with the approver recorded, compare-and-set under a row lock, audit in the same transaction.
-- The route keeps the role, tier, scope and self-rejection checks; the maker_checker CHECK and the approver-role
-- trigger stay as the database's own guards. Replaces the update + audit + put-it-back code in decide.ts.

create or replace function nopm_reject_deletion_request(
  p_workspace_id          uuid,
  p_request_id            uuid,
  p_approver_type         text,
  p_approver_id           uuid,
  p_approver_label        text,
  p_approver_principal_id uuid,
  p_reason                text,
  p_audit                 jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r deletion_requests%rowtype;
begin
  if p_approver_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;
  if p_audit is null or (p_audit ->> 'action') is distinct from 'deletion_request.rejected' then
    raise exception 'INVALID_AUDIT: action must be deletion_request.rejected' using errcode = 'P0059';
  end if;

  select * into r from deletion_requests where id = p_request_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception 'ALREADY_DECIDED' using errcode = 'P0001';
  end if;

  update deletion_requests
     set status = 'rejected',
         approved_by_type = p_approver_type::actor_type,
         approved_by_id = p_approver_id,
         approved_by_label = p_approver_label,
         approved_principal_id = p_approver_principal_id,
         decided_at = now()
   where id = p_request_id and workspace_id = p_workspace_id
   returning * into r;

  perform nopm_audit_insert(
    p_workspace_id, p_audit, r.id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'approver_principal_id', p_approver_principal_id, 'reason', p_reason));

  return jsonb_build_object('id', r.id, 'status', r.status);
end;
$$;

-- == 5. raise a change request (every tier except emergency) ====================================================
-- Inserts the request, its change_request.create audit row (after = the stored row) and the deadline_set event
-- together. p_input carries what the raiser chose (project_id, reference_id, title, description, category, priority,
-- status, impact_*, target_date, raised_at, requested_by*); the tier, deadline and assigned approver come from the
-- app's policy lookup. An emergency commits on raise and keeps its own function (0106). A reference-number clash
-- is the unique violation 23505, so the app can retry with the next number.

create or replace function nopm_raise_change_request(
  p_workspace_id         uuid,
  p_input                jsonb,
  p_tier                 text,
  p_deadline             timestamptz,
  p_assigned_approver_id uuid,
  p_principal_id         uuid,
  p_event_detail         jsonb,
  p_audit                jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid := nullif(p_input ->> 'project_id', '')::uuid;
  r         change_requests%rowtype;
begin
  if p_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;
  if p_tier is null or p_tier = 'emergency' then
    raise exception 'EMERGENCY_VIA_OTHER_FUNCTION: use nopm_raise_emergency_change_request' using errcode = 'P0061';
  end if;
  if p_audit is null or (p_audit ->> 'action') is distinct from 'change_request.create' then
    raise exception 'INVALID_AUDIT: action must be change_request.create' using errcode = 'P0059';
  end if;
  if p_assigned_approver_id is not null and not exists (select 1 from profiles where id = p_assigned_approver_id and workspace_id = p_workspace_id) then
    raise exception 'INVALID_ASSIGNEE' using errcode = 'P0064';
  end if;
  if v_project is null or not exists (select 1 from projects where id = v_project and workspace_id = p_workspace_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into change_requests (
    workspace_id, project_id, reference_id, title, description, category, priority, status, tier,
    approval_deadline_at, impact_summary, impact_schedule_days, impact_cost, impact_scope, target_date, raised_at,
    requested_by, requested_by_label, requested_by_type, requested_by_id, requested_principal_id, assigned_approver_id
  ) values (
    p_workspace_id,
    v_project,
    nullif(p_input ->> 'reference_id', ''),
    p_input ->> 'title',
    p_input ->> 'description',
    coalesce(p_input ->> 'category', 'scope'),
    coalesce(p_input ->> 'priority', 'medium'),
    coalesce(p_input ->> 'status', 'raised'),
    p_tier,
    p_deadline,
    p_input ->> 'impact_summary',
    nullif(p_input ->> 'impact_schedule_days', '')::int,
    nullif(p_input ->> 'impact_cost', '')::numeric,
    case when jsonb_typeof(p_input -> 'impact_scope') = 'array' then p_input -> 'impact_scope' else null end,
    nullif(p_input ->> 'target_date', '')::date,
    coalesce(nullif(p_input ->> 'raised_at', '')::timestamptz, now()),
    nullif(p_input ->> 'requested_by', '')::uuid,
    p_input ->> 'requested_by_label',
    nullif(p_input ->> 'requested_by_type', '')::actor_type,
    nullif(p_input ->> 'requested_by_id', '')::uuid,
    p_principal_id,
    p_assigned_approver_id
  ) returning * into r;

  perform nopm_audit_insert(p_workspace_id, p_audit, r.id, null, to_jsonb(r));

  insert into approval_events (workspace_id, target_type, target_id, kind, actor_label, detail)
    values (p_workspace_id, 'change_request', r.id, 'deadline_set', p_audit ->> 'actor_label', p_event_detail)
    on conflict do nothing;

  return to_jsonb(r);
end;
$$;

-- == 6. edit an open change request =============================================================================
-- Locks the row, re-checks that it is still open (raised / under_review) and still the editor's, applies only the
-- keys present in p_updates (an explicit null clears a nullable field), and writes change_request.update with
-- before = the locked row and after = the stored row. Errors: P0002 not found, P0001 CR_DECIDED (decided between
-- the route's read and this lock), P0023 NOT_REQUESTER.

create or replace function nopm_edit_change_request(
  p_workspace_id uuid,
  p_id           uuid,
  p_updates      jsonb,
  p_editor_principal uuid,
  p_audit        jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  old_r change_requests%rowtype;
  new_r change_requests%rowtype;
  u     jsonb := coalesce(p_updates, '{}'::jsonb);
begin
  if p_editor_principal is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;
  if p_audit is null or (p_audit ->> 'action') is distinct from 'change_request.update' then
    raise exception 'INVALID_AUDIT: action must be change_request.update' using errcode = 'P0059';
  end if;

  select * into old_r from change_requests where id = p_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if old_r.status not in ('raised', 'under_review') then
    raise exception 'CR_DECIDED' using errcode = 'P0001';
  end if;
  if old_r.requested_principal_id is not null and old_r.requested_principal_id <> p_editor_principal then
    raise exception 'NOT_REQUESTER' using errcode = 'P0023';
  end if;

  if u = '{}'::jsonb then
    new_r := old_r;
  else
    update change_requests set
      title                = case when u ? 'title' then u ->> 'title' else title end,
      description          = case when u ? 'description' then u ->> 'description' else description end,
      category             = case when u ? 'category' then u ->> 'category' else category end,
      priority             = case when u ? 'priority' then u ->> 'priority' else priority end,
      impact_summary       = case when u ? 'impact_summary' then u ->> 'impact_summary' else impact_summary end,
      impact_schedule_days = case when u ? 'impact_schedule_days' then nullif(u ->> 'impact_schedule_days', '')::int else impact_schedule_days end,
      impact_cost          = case when u ? 'impact_cost' then nullif(u ->> 'impact_cost', '')::numeric else impact_cost end,
      impact_scope         = case when u ? 'impact_scope'
                                  then case when jsonb_typeof(u -> 'impact_scope') = 'array' then u -> 'impact_scope' else null end
                                  else impact_scope end,
      target_date          = case when u ? 'target_date' then nullif(u ->> 'target_date', '')::date else target_date end,
      raised_at            = case when u ? 'raised_at' then (u ->> 'raised_at')::timestamptz else raised_at end
     where id = p_id and workspace_id = p_workspace_id
     returning * into new_r;
  end if;

  perform nopm_audit_insert(p_workspace_id, p_audit, new_r.id, to_jsonb(old_r), to_jsonb(new_r));

  return to_jsonb(new_r);
end;
$$;

-- == 7. withdraw (delete) an open change request ================================================================
-- Same lock and the same open / requester re-checks as the edit; deletes the row and writes change_request.delete
-- with before = the row and after = null, in one transaction. (The route and the audit action have always been
-- called delete; "withdraw" is the name of the act.)

create or replace function nopm_withdraw_change_request(
  p_workspace_id     uuid,
  p_id               uuid,
  p_editor_principal uuid,
  p_audit            jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  old_r change_requests%rowtype;
begin
  if p_editor_principal is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;
  if p_audit is null or (p_audit ->> 'action') is distinct from 'change_request.delete' then
    raise exception 'INVALID_AUDIT: action must be change_request.delete' using errcode = 'P0059';
  end if;

  select * into old_r from change_requests where id = p_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if old_r.status not in ('raised', 'under_review') then
    raise exception 'CR_DECIDED' using errcode = 'P0001';
  end if;
  if old_r.requested_principal_id is not null and old_r.requested_principal_id <> p_editor_principal then
    raise exception 'NOT_REQUESTER' using errcode = 'P0023';
  end if;

  delete from change_requests where id = p_id and workspace_id = p_workspace_id;

  perform nopm_audit_insert(p_workspace_id, p_audit, old_r.id, to_jsonb(old_r), null);

  return to_jsonb(old_r);
end;
$$;

-- == 8. propose a rebaseline ====================================================================================
-- Locks the project row, requires it to be locked (Q-GOV-4), takes the next version, stores the exact dates
-- (before = the baseline they replace, after = the project's locked dates; a free-text note rides along as `note`),
-- and writes rebaseline.create plus the deadline_set event together. A second pending proposal or a racing version
-- is the unique violation 23505 (uniq_pending_rebaseline / the version index); the route maps it as before.

create or replace function nopm_propose_rebaseline(
  p_workspace_id         uuid,
  p_project_id           uuid,
  p_reason               text,
  p_tier                 text,
  p_deadline             timestamptz,
  p_assigned_approver_id uuid,
  p_requested_by         uuid,
  p_principal_id         uuid,
  p_note_before          jsonb,
  p_note_after           jsonb,
  p_audit                jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p        projects%rowtype;
  v_ver    integer;
  v_before jsonb;
  v_after  jsonb;
  r        rebaselines%rowtype;
begin
  if p_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;
  if p_audit is null or (p_audit ->> 'action') is distinct from 'rebaseline.create' then
    raise exception 'INVALID_AUDIT: action must be rebaseline.create' using errcode = 'P0059';
  end if;

  if p_assigned_approver_id is not null and not exists (select 1 from profiles where id = p_assigned_approver_id and workspace_id = p_workspace_id) then
    raise exception 'INVALID_ASSIGNEE' using errcode = 'P0064';
  end if;

  select * into p from projects where id = p_project_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not coalesce(p.is_locked, false) then
    raise exception 'PROJECT_NOT_LOCKED' using errcode = 'P0019';
  end if;

  select coalesce(max(version), 0) + 1 into v_ver
    from rebaselines where project_id = p_project_id and workspace_id = p_workspace_id;

  v_before := jsonb_build_object('start_date', p.baseline_start_date, 'target_date', p.baseline_target_date);
  v_after  := jsonb_build_object('start_date', p.start_date, 'target_date', p.target_date);
  if p_note_before is not null and jsonb_typeof(p_note_before) <> 'null' and p_note_before <> '""'::jsonb then
    v_before := v_before || jsonb_build_object('note', p_note_before);
  end if;
  if p_note_after is not null and jsonb_typeof(p_note_after) <> 'null' and p_note_after <> '""'::jsonb then
    v_after := v_after || jsonb_build_object('note', p_note_after);
  end if;

  insert into rebaselines (
    workspace_id, project_id, version, status, tier, approval_deadline_at, reason,
    requested_by, requested_principal_id, before, after, assigned_approver_id
  ) values (
    p_workspace_id, p_project_id, v_ver, 'pending_approval', p_tier, p_deadline, p_reason,
    p_requested_by, p_principal_id, v_before, v_after, p_assigned_approver_id
  ) returning * into r;

  perform nopm_audit_insert(p_workspace_id, p_audit, r.id, null, to_jsonb(r));

  insert into approval_events (workspace_id, target_type, target_id, kind, actor_label, detail)
    values (p_workspace_id, 'rebaseline', r.id, 'deadline_set', p_audit ->> 'actor_label',
            jsonb_build_object('tier', p_tier,
                               'deadline', case when p_deadline is null then null
                                                else to_char(p_deadline at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end))
    on conflict do nothing;

  return to_jsonb(r);
end;
$$;

-- == 9. grants ==================================================================================================

revoke execute on function nopm_request_deletion(uuid, text, uuid, text, uuid, text, timestamptz, text, uuid, text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function nopm_request_deletion(uuid, text, uuid, text, uuid, text, timestamptz, text, uuid, text, uuid, jsonb, jsonb) to service_role;

revoke execute on function nopm_withdraw_deletion_request(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant  execute on function nopm_withdraw_deletion_request(uuid, uuid, text, jsonb) to service_role;

revoke execute on function nopm_reject_deletion_request(uuid, uuid, text, uuid, text, uuid, text, jsonb) from public, anon, authenticated;
grant  execute on function nopm_reject_deletion_request(uuid, uuid, text, uuid, text, uuid, text, jsonb) to service_role;

revoke execute on function nopm_raise_change_request(uuid, jsonb, text, timestamptz, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function nopm_raise_change_request(uuid, jsonb, text, timestamptz, uuid, uuid, jsonb, jsonb) to service_role;

revoke execute on function nopm_edit_change_request(uuid, uuid, jsonb, uuid, jsonb) from public, anon, authenticated;
grant  execute on function nopm_edit_change_request(uuid, uuid, jsonb, uuid, jsonb) to service_role;

revoke execute on function nopm_withdraw_change_request(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant  execute on function nopm_withdraw_change_request(uuid, uuid, uuid, jsonb) to service_role;

revoke execute on function nopm_propose_rebaseline(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function nopm_propose_rebaseline(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid, jsonb, jsonb, jsonb) to service_role;

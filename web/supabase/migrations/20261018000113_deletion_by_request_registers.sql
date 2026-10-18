-- NoPM · 0113 (2026-10-18) — deletion by request for programs, sprints, resources, allocations and clashes
-- (M1 close-out, W5-G, audit gap G8, R-176). PRE-DEPLOY: apply BEFORE the build that raises these requests.
-- The delete-refusing triggers are a SEPARATE file (0114) applied AFTER that build is live (PR-19).
--
-- ROLLBACK (run by hand; nothing here deletes data).
--   drop function if exists nopm_commit_program_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);
--   drop function if exists nopm_commit_sprint_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);
--   drop function if exists nopm_commit_resource_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);
--   drop function if exists nopm_commit_allocation_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);
--   drop function if exists nopm_commit_clash_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);
--   delete from nopm_deletion_entities where entity in ('program', 'sprint', 'resource', 'allocation', 'clash');
--   re-run 20261017000056's nopm_commit_task_deletion (the version without the flag line);
--   re-run 20261018000106's nopm_deletion_tier_default (the version without the program branch);
--   alter table deletion_requests drop constraint deletion_requests_target_type_check, then re-add the 0102 list.
--
-- WHY. A program, a sprint, a resource member, an allocation and a clash were still removed by one person with one
-- write scope (audited, but never second-checked). A resource delete also erases the member's allocations, and a
-- project delete removes sprints, allocations and clashes. This migration makes the same four-eyes path of the
-- other records (0102) available for these five, and makes every commit that cascades into them ready for the
-- trigger of 0114.
--
-- WHAT.
--   1. deletion_requests.target_type CHECK widens to the five new types (added NOT VALID, then validated; a failed
--      validation RAISES, so a bad row can never be left behind quietly).
--   2. The five entities are inserted into nopm_deletion_entities (0108), so nopm_request_deletion needs no change.
--      child_count_sql records what approving also touches: program -> its projects (detached, never deleted),
--      sprint -> its attached tasks (detached), resource -> its allocations (deleted) and assigned tasks
--      (unassigned). allocation and clash have no children.
--   3. One commit RPC per entity (nopm_commit_<entity>_deletion), modelled on 0102: the delete, the request update and
--      BOTH audit rows in one transaction, the request locked FOR UPDATE, the same guards and errcodes as the other
--      records (P0002 NOT_FOUND, P0001 ALREADY_DECIDED, P0003 SELF_APPROVAL, P0005 INVALID_CHANNEL, P0006
--      NO_PRINCIPAL, P0017 TARGET_GONE, P0018 ROLE_NOT_PERMITTED). Per entity:
--        program   P0016 CHILDREN_CHANGED when the number of projects in it moved since the request.
--        sprint    P0063 SPRINT_NOT_PLANNED (only a planned sprint), P0016 when the attached-task count moved.
--        resource  P0062 HAS_TIMESHEET_RECORDS (archived timesheets are approval history), P0016 when the
--                  allocation count moved; the cascaded allocation ids are written into resource.delete `after`
--                  (after.cascade_deleted.allocations = { count, ids }, PR-21).
--        allocation, clash   no guard beyond the common ones.
--      The audit action is a compile-time literal per function (program.delete, sprint.delete, resource.delete,
--      allocation.delete, clash.delete): the SAME names the direct deletes wrote, with the same `before` (the
--      row) and a null `after` (resource.delete excepted). Do NOT merge them (see the 0032 header, KNOWN TRAP).
--   4. nopm_commit_task_deletion is redefined with ONE extra line: it sets nopm.deletion_commit before the delete
--      (PR-01). The task delete cascades allocations (allocations.task_id is on delete cascade), so once 0114
--      attaches the refusing trigger to allocations, an approved task deletion would fail without it. The body is
--      otherwise 0056's, character for character.
--   5. nopm_deletion_tier_default (0106) gains a program branch: a program deletion is high_risk (the tier is fixed
--      by the build, not routable in Settings, D15). The other four stay normal.
--
-- EVERY FUNCTION THAT CAN DELETE FROM THE FIVE TABLES (the migration test and the probe check each):
--   direct DELETE on the table   nopm_commit_{program,sprint,resource,allocation,clash}_deletion (this file), which set the flag.
--   cascade from tasks           nopm_commit_task_deletion (allocations): sets the flag since this file.
--   cascade from projects        nopm_commit_project_deletion (sprints, allocations, clashes): sets it since 0102.
--   cascade from resource_members  nopm_commit_resource_deletion (allocations): sets the flag.
--   cascade from sprints/programs  none (tasks.sprint_id and projects.program_id are on delete set null).
--   cascade from workspaces      workspace purge: an operator act under session_replication_role = replica (0102 header).
--   No other function in the schema issues a DELETE on these tables or on tasks, projects or resource_members.
--
-- BEHAVIOUR ON EXISTING ROWS. Additive. No row is changed, deleted or re-typed: existing deletion_requests rows all
-- carry one of the seven old types, which the widened CHECK still allows. Existing audit rows are untouched. The old
-- build keeps working after this file: its DELETE routes still delete directly (no trigger yet, that is 0114).
-- ORDER OF APPLY. After 0112, BEFORE the build. Then deploy. Then 0114.

-- == 1. target_type CHECK ======================================================

alter table deletion_requests drop constraint if exists deletion_requests_target_type_check;
alter table deletion_requests
  add constraint deletion_requests_target_type_check
  check (target_type in ('task', 'project', 'risk', 'issue', 'expense', 'document', 'milestone',
                         'program', 'sprint', 'resource', 'allocation', 'clash')) not valid;
do $$
begin
  alter table deletion_requests validate constraint deletion_requests_target_type_check;
exception when check_violation then
  raise exception '0113: deletion_requests holds a target_type outside the allowed list: %', sqlerrm;
end $$;

-- == 2. the entity map ==========================================================

insert into nopm_deletion_entities (entity, table_name, commit_rpc, child_count_sql) values
  ('program',    'programs',         'nopm_commit_program_deletion',
     'select jsonb_build_object(''projects'', count(*)) from projects where workspace_id = $1 and program_id = $2'),
  ('sprint',     'sprints',          'nopm_commit_sprint_deletion',
     'select jsonb_build_object(''tasks'', count(*)) from tasks where workspace_id = $1 and sprint_id = $2'),
  ('resource',   'resource_members', 'nopm_commit_resource_deletion',
     'select jsonb_build_object(''allocations'', (select count(*) from allocations where workspace_id = $1 and member_id = $2), ''allocation_ids'', (select coalesce(jsonb_agg(id order by id), ''[]''::jsonb) from allocations where workspace_id = $1 and member_id = $2), ''assigned_tasks'', (select count(*) from tasks where workspace_id = $1 and assignee_id = $2))'),
  ('allocation', 'allocations',      'nopm_commit_allocation_deletion', null),
  ('clash',      'clashes',          'nopm_commit_clash_deletion',      null)
on conflict (entity) do update
  set table_name = excluded.table_name, commit_rpc = excluded.commit_rpc, child_count_sql = excluded.child_count_sql;

-- == 3. commit RPCs, one per entity =============================================

-- == nopm_commit_program_deletion (new) ==

drop function if exists nopm_commit_program_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_program_deletion(
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
  v_n integer := 0;
  v_expected integer;
  v_ids jsonb := '[]'::jsonb;
  v_state text;
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'program'
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
  -- Tier role (0100): the approver must meet the request's tier (a program is high_risk, the others normal).
  if not nopm_principal_meets_tier(p_workspace_id, r.tier, p_approver_principal_id) then
    raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(p_workspace_id, r.tier), r.tier using errcode = 'P0018';
  end if;

  -- The program row is locked FOR UPDATE first: a project that joins the program takes a key-share lock on it, so
  -- none can join between the count below and the delete. Deleting a program detaches its projects
  -- (projects.program_id is on delete set null); it never deletes them.
  perform 1 from programs where id = r.target_id and workspace_id = p_workspace_id for update;
  select count(*) into v_n from projects where program_id = r.target_id and workspace_id = p_workspace_id;
  v_expected := nullif(r.before -> 'child_counts' ->> 'projects', '')::integer;
  if v_expected is not null and v_expected <> v_n then
    raise exception 'CHILDREN_CHANGED: the projects in this program changed after the deletion was requested — raise a new request so the approver sees the current scope'
      using errcode = 'P0016';
  end if;

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop of 0114 through for this transaction only.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from programs where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the program no longer exists, so there is nothing to delete'
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
            'program.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_program_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_program_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == nopm_commit_sprint_deletion (new) ==

drop function if exists nopm_commit_sprint_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_sprint_deletion(
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
  v_n integer := 0;
  v_expected integer;
  v_ids jsonb := '[]'::jsonb;
  v_state text;
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'sprint'
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
  -- Tier role (0100): the approver must meet the request's tier (a program is high_risk, the others normal).
  if not nopm_principal_meets_tier(p_workspace_id, r.tier, p_approver_principal_id) then
    raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(p_workspace_id, r.tier), r.tier using errcode = 'P0018';
  end if;

  -- Same rule as the direct delete had: only a planned sprint, with no attached tasks. Locked FOR UPDATE so it cannot
  -- be started or gain tasks mid-commit. P0063 SPRINT_NOT_PLANNED; P0016 when the attached-task count moved.
  select s.state into v_state from sprints s where s.id = r.target_id and s.workspace_id = p_workspace_id for update;
  if v_state is not null and v_state <> 'planned' then
    raise exception 'SPRINT_NOT_PLANNED: only a planned sprint can be deleted' using errcode = 'P0063';
  end if;
  select count(*) into v_n from tasks where sprint_id = r.target_id and workspace_id = p_workspace_id;
  v_expected := nullif(r.before -> 'child_counts' ->> 'tasks', '')::integer;
  if v_expected is not null and v_expected <> v_n then
    raise exception 'CHILDREN_CHANGED: the tasks in this sprint changed after the deletion was requested — raise a new request so the approver sees the current scope'
      using errcode = 'P0016';
  end if;

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop of 0114 through for this transaction only.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from sprints where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the sprint no longer exists, so there is nothing to delete'
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
            'sprint.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_sprint_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_sprint_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == nopm_commit_resource_deletion (new) ==

drop function if exists nopm_commit_resource_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_resource_deletion(
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
  v_n integer := 0;
  v_expected integer;
  v_ids jsonb := '[]'::jsonb;
  v_state text;
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'resource'
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
  -- Tier role (0100): the approver must meet the request's tier (a program is high_risk, the others normal).
  if not nopm_principal_meets_tier(p_workspace_id, r.tier, p_approver_principal_id) then
    raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(p_workspace_id, r.tier), r.tier using errcode = 'P0018';
  end if;

  -- The member row is locked FOR UPDATE first (a new allocation takes a key-share lock on it). Archived timesheet
  -- submissions cascade from the member and are the approval history of every sheet, so the direct delete refused
  -- a member who ever had one; the same refusal is repeated here (P0062 HAS_TIMESHEET_RECORDS, PR-21).
  perform 1 from resource_members where id = r.target_id and workspace_id = p_workspace_id for update;
  if exists (select 1 from timesheet_submissions where member_id = r.target_id and workspace_id = p_workspace_id) then
    raise exception 'HAS_TIMESHEET_RECORDS: this member has archived hours, kept for the record, so the member cannot be deleted'
      using errcode = 'P0062';
  end if;
  -- The cascade removes the member's allocations, which have no audit row of their own: read their ids now and
  -- write them into the one resource.delete row (after.cascade_deleted).
  select count(*), coalesce(jsonb_agg(a.id order by a.id), '[]'::jsonb) into v_n, v_ids
    from allocations a where a.member_id = r.target_id and a.workspace_id = p_workspace_id;
  v_expected := nullif(r.before -> 'child_counts' ->> 'allocations', '')::integer;
  if v_expected is not null and v_expected <> v_n then
    raise exception 'CHILDREN_CHANGED: the allocations of this resource changed after the deletion was requested — raise a new request so the approver sees the current scope'
      using errcode = 'P0016';
  end if;

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop of 0114 through for this transaction only.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from resource_members where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the resource no longer exists, so there is nothing to delete'
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
            'resource.delete', r.target_type, r.target_id, r.before, jsonb_build_object('cascade_deleted', jsonb_build_object('allocations', jsonb_build_object('count', v_n, 'ids', v_ids))), p_channel, p_correlation_id,
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
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_resource_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_resource_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == nopm_commit_allocation_deletion (new) ==

drop function if exists nopm_commit_allocation_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_allocation_deletion(
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
  v_n integer := 0;
  v_expected integer;
  v_ids jsonb := '[]'::jsonb;
  v_state text;
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'allocation'
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
  -- Tier role (0100): the approver must meet the request's tier (a program is high_risk, the others normal).
  if not nopm_principal_meets_tier(p_workspace_id, r.tier, p_approver_principal_id) then
    raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(p_workspace_id, r.tier), r.tier using errcode = 'P0018';
  end if;

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop of 0114 through for this transaction only.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from allocations where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the allocation no longer exists, so there is nothing to delete'
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
            'allocation.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_allocation_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_allocation_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == nopm_commit_clash_deletion (new) ==

drop function if exists nopm_commit_clash_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_clash_deletion(
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
  v_n integer := 0;
  v_expected integer;
  v_ids jsonb := '[]'::jsonb;
  v_state text;
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'clash'
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
  -- Tier role (0100): the approver must meet the request's tier (a program is high_risk, the others normal).
  if not nopm_principal_meets_tier(p_workspace_id, r.tier, p_approver_principal_id) then
    raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(p_workspace_id, r.tier), r.tier using errcode = 'P0018';
  end if;

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop of 0114 through for this transaction only.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from clashes where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the clash no longer exists, so there is nothing to delete'
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
            'clash.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_clash_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_clash_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == 4. nopm_commit_task_deletion (from 20261017000056, plus the cascade setting, PR-01) ==

drop function if exists nopm_commit_task_deletion(uuid, uuid, text, uuid, text, text, text);

create or replace function nopm_commit_task_deletion(
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

  -- 1. delete the target (only 'task' supported today)
  if r.target_type = 'task' then
    -- 0113 (PR-01): the delete cascades allocations (allocations.task_id is on delete cascade). The setting lets the
    -- BEFORE DELETE backstop of 0114 through for this transaction only.
    perform set_config('nopm.deletion_commit', 'on', true);
    delete from tasks where id = r.target_id and workspace_id = p_workspace_id;
    -- 0056: a delete that removed nothing must not be committed or audited. The
    -- task can already be gone (a project deletion cascaded it, or another path
    -- removed it). Raising rolls the whole call back, so no task.delete row
    -- names this approver for something they did not delete; the caller closes
    -- the stale request (decide.ts, target_gone).
    get diagnostics v_deleted = row_count;
    if v_deleted = 0 then
      raise exception 'TARGET_GONE: the task no longer exists, so there is nothing to delete'
        using errcode = 'P0017';
    end if;
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
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'task.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

  -- 4. audit the governance step itself — records the HUMAN behind the
  --    approver and the approver's optional note.
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'deletion_request.approved', 'deletion_request', r.id,
            jsonb_build_object('status', 'pending'),
            jsonb_build_object('status', 'committed', 'approver_principal_id', p_approver_principal_id)
              || case when v_note is not null then jsonb_build_object('note', v_note) else '{}'::jsonb end,
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref);

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

revoke execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == 5. nopm_deletion_tier_default (from 20261018000106, plus the program branch) ==

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
    if new.target_type in ('project', 'program') then
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

-- NoPM · 0102 (2026-10-18) — deletion is a REQUEST for every governed record (audit gap G8, A8).
--
-- WHY. Tasks (0020) and projects (0032) were already deleted only after a second person
-- approved a deletion_requests row. Risks, issues, expenses (money records), documents
-- (including approved ones) and milestones were still hard-deleted by any non-viewer holding
-- a write scope: audited, but by one person, and the database itself would let a service-role
-- DELETE through. This migration closes both gaps.
--
-- WHAT.
--   1. deletion_requests.target_type gets a CHECK: task | project | risk | issue | expense |
--      document | milestone (added NOT VALID, then validated; a failed validate leaves it NOT VALID
--      with a notice so existing rows can never block the deploy).
--   2. One commit RPC per new type, each modelled on nopm_commit_task_deletion (0056): the delete,
--      the request update and BOTH audit rows run in one transaction, the request is locked FOR
--      UPDATE, the guards and errcodes are the same (P0002 NOT_FOUND, P0001 ALREADY_DECIDED,
--      P0003 SELF_APPROVAL, P0005 INVALID_CHANNEL, P0006 NO_PRINCIPAL, P0017 TARGET_GONE). The audit
--      action string is a compile-time literal per function (risk.delete, issue.delete, expense.delete,
--      document.delete, milestone.delete) next to deletion_request.approved. Do NOT merge them into one
--      parameterised function (see the 0032 header, KNOWN TRAP).
--        milestone  P0010 PROJECT_LOCKED when the parent project is locked (schedule shape), and
--                   P0016 CHILDREN_CHANGED when the number of tasks on the milestone differs from the
--                   count the approver was shown at request time (before.child_counts.tasks).
--        document   P0041 APPROVED_DOCUMENT_NEEDS_ADMIN: an approved document is deleted only on a request
--                   raised by an admin and approved by an admin (decision 25, tier B; P0041 requester, P0042 approver). The stored file's path is returned as
--                   document_path so the caller can remove the object after the commit.
--   (SQLSTATEs: this migration owns P0040 DELETE_NEEDS_REQUEST, P0041 APPROVED_DOCUMENT_NEEDS_ADMIN (requester not an admin)
--   and P0042 APPROVED_DOCUMENT_APPROVER_NOT_ADMIN. 0100 and 0101 use P0030 and P0031 for other errors; none is reused here.)
--   3. DB backstop: BEFORE DELETE triggers on risks, issues, expenses, documents and milestones raise
--      P0040 DELETE_NEEDS_REQUEST unless the transaction-local setting nopm.deletion_commit is 'on'.
--      Only the commit RPCs (and nopm_commit_project_deletion, for the cascade) set it, so even a
--      service-role DELETE with no approved request is refused. Same shape as nopm.lock_bypass (0028):
--      set_config(..., true) is local to the transaction and resets on commit or rollback.
--      Operators who must bulk-delete (a workspace purge) can run under session_replication_role =
--      replica, which does not fire these triggers; that is a deliberate, visible act.
--   4. nopm_commit_project_deletion is recreated with the one extra line that sets the setting before
--      the cascade (single overload, signature unchanged from 0076).
--   5. The chat hub's approval_kind CHECKs (integration_deliveries, action_tokens) widen to the five new
--      kinds, so a Lark card for a risk deletion can be stored.
--
-- No updated_at bump, no RLS or grant change on any table. RPCs are revoked from public and granted to
-- service_role only, like the task and project ones.
--
-- ORDER OF APPLY. Apply BEFORE deploying the build that raises these requests. An old build keeps
-- calling DELETE on the five tables and gets P0040 (surfaced as a 500) until the new build is live,
-- so deploy right after the migration.
-- ROLLBACK. drop trigger trg_<table>_delete_needs_request on each table; drop function
-- nopm_refuse_direct_delete(); drop function nopm_commit_<entity>_deletion(...) for the five entities;
-- re-run 0076's nopm_commit_project_deletion; drop constraint deletion_requests_target_type_check.

-- == 1. target_type CHECK ======================================================

alter table deletion_requests drop constraint if exists deletion_requests_target_type_check;
alter table deletion_requests
  add constraint deletion_requests_target_type_check
  check (target_type in ('task', 'project', 'risk', 'issue', 'expense', 'document', 'milestone')) not valid;
do $$
begin
  alter table deletion_requests validate constraint deletion_requests_target_type_check;
exception when check_violation then
  raise notice '0102: deletion_requests.target_type CHECK left NOT VALID (existing rows with another type): %', sqlerrm;
end $$;

-- The chat hub stores the approval kind it sent a card for.
alter table integration_deliveries drop constraint if exists integration_deliveries_approval_kind_check;
alter table integration_deliveries
  add constraint integration_deliveries_approval_kind_check
  check (approval_kind is null or approval_kind in
    ('task_deletion', 'project_deletion', 'risk_deletion', 'issue_deletion', 'expense_deletion',
     'document_deletion', 'milestone_deletion', 'change_request', 'timesheet', 'rebaseline_signoff')) not valid;
alter table integration_deliveries validate constraint integration_deliveries_approval_kind_check;

alter table action_tokens drop constraint if exists action_tokens_approval_kind_check;
alter table action_tokens
  add constraint action_tokens_approval_kind_check
  check (approval_kind in
    ('task_deletion', 'project_deletion', 'risk_deletion', 'issue_deletion', 'expense_deletion',
     'document_deletion', 'milestone_deletion', 'change_request', 'timesheet', 'rebaseline_signoff')) not valid;
alter table action_tokens validate constraint action_tokens_approval_kind_check;

-- == 2. commit RPCs, one per type ===============================================

-- == nopm_commit_risk_deletion (new) ==

drop function if exists nopm_commit_risk_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_risk_deletion(
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'risk'
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

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop trigger through for this
  --    transaction only; nothing else sets it.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from risks where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the risk no longer exists, so there is nothing to delete'
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
            'risk.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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

revoke execute on function nopm_commit_risk_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_risk_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == nopm_commit_issue_deletion (new) ==

drop function if exists nopm_commit_issue_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_issue_deletion(
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'issue'
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

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop trigger through for this
  --    transaction only; nothing else sets it.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from issues where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the issue no longer exists, so there is nothing to delete'
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
            'issue.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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

revoke execute on function nopm_commit_issue_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_issue_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == nopm_commit_expense_deletion (new) ==

drop function if exists nopm_commit_expense_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_expense_deletion(
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'expense'
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

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop trigger through for this
  --    transaction only; nothing else sets it.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from expenses where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the expense no longer exists, so there is nothing to delete'
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
            'expense.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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

revoke execute on function nopm_commit_expense_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_expense_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == nopm_commit_document_deletion (new) ==

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
  v_role text;
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

  -- Decision 25 (tier B): an approved document carries a signed-off record. It is deleted only when the
  -- request was raised by an admin. The requester's role is read from the person behind the request.
  select d.status, d.storage_path into v_status, v_path from documents d
    where d.id = r.target_id and d.workspace_id = p_workspace_id;
  if v_status = 'approved' then
    select role::text into v_role from profiles
      where id = r.requested_principal_id and workspace_id = p_workspace_id;
    if v_role is distinct from 'admin' then
      raise exception 'APPROVED_DOCUMENT_NEEDS_ADMIN: an approved document is deleted only on a request raised by an admin'
        using errcode = 'P0041';
    end if;
    -- W4-14: the approver of a sign-off record is an admin too (the request is high_risk, which is admin-tier).
    if not exists (select 1 from profiles where id = p_approver_principal_id and workspace_id = p_workspace_id and role::text = 'admin') then
      raise exception 'APPROVED_DOCUMENT_APPROVER_NOT_ADMIN: an approved document is deleted only when an admin approves it'
        using errcode = 'P0042';
    end if;
  end if;

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

-- == nopm_commit_milestone_deletion (new) ==

drop function if exists nopm_commit_milestone_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text);

create or replace function nopm_commit_milestone_deletion(
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
  v_project uuid;
  v_locked boolean;
  v_tasks integer;
  v_expected integer;
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
    where id = p_request_id and workspace_id = p_workspace_id and target_type = 'milestone'
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

  -- A locked project's schedule shape is frozen (0028): removing a milestone is refused cleanly and
  -- early. The project row is locked FOR UPDATE so it cannot be locked or gain tasks mid-commit.
  select m.project_id into v_project from milestones m
    where m.id = r.target_id and m.workspace_id = p_workspace_id;
  if v_project is not null then
    select is_locked into v_locked from projects
      where id = v_project and workspace_id = p_workspace_id
      for update;
    if v_locked then
      raise exception 'PROJECT_LOCKED: project schedule is frozen — unlock the project or apply a rebaseline before deleting this milestone'
        using errcode = 'P0010';
    end if;
    -- The approver was shown how many tasks sit on this milestone; the delete detaches them
    -- (milestone_id set null). If that number moved, the request no longer describes the delete.
    select count(*) into v_tasks from tasks where milestone_id = r.target_id and workspace_id = p_workspace_id;
    v_expected := nullif(r.before -> 'child_counts' ->> 'tasks', '')::integer;
    if v_expected is not null and v_expected <> v_tasks then
      raise exception 'CHILDREN_CHANGED: the tasks on this milestone changed after the deletion was requested — raise a new request so the approver sees the current scope'
        using errcode = 'P0016';
    end if;
  end if;

  -- 1. delete the target. The setting lets the BEFORE DELETE backstop trigger through for this
  --    transaction only; nothing else sets it.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from milestones where id = r.target_id and workspace_id = p_workspace_id;
  -- A delete that removed nothing must not be committed or audited (the record is already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the milestone no longer exists, so there is nothing to delete'
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
            'milestone.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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

revoke execute on function nopm_commit_milestone_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_milestone_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == 3. DB backstop: no direct delete ===========================================

create or replace function nopm_refuse_direct_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('nopm.deletion_commit', true) = 'on' then
    return old;
  end if;
  raise exception 'DELETE_NEEDS_REQUEST: % rows are removed only by an approved deletion request', tg_table_name
    using errcode = 'P0040';
end;
$$;

revoke execute on function nopm_refuse_direct_delete() from public, anon, authenticated;
grant  execute on function nopm_refuse_direct_delete() to service_role;

drop trigger if exists trg_risks_delete_needs_request on risks;
create trigger trg_risks_delete_needs_request
  before delete on risks
  for each row execute function nopm_refuse_direct_delete();

drop trigger if exists trg_issues_delete_needs_request on issues;
create trigger trg_issues_delete_needs_request
  before delete on issues
  for each row execute function nopm_refuse_direct_delete();

drop trigger if exists trg_expenses_delete_needs_request on expenses;
create trigger trg_expenses_delete_needs_request
  before delete on expenses
  for each row execute function nopm_refuse_direct_delete();

drop trigger if exists trg_documents_delete_needs_request on documents;
create trigger trg_documents_delete_needs_request
  before delete on documents
  for each row execute function nopm_refuse_direct_delete();

drop trigger if exists trg_milestones_delete_needs_request on milestones;
create trigger trg_milestones_delete_needs_request
  before delete on milestones
  for each row execute function nopm_refuse_direct_delete();

-- == 4. nopm_commit_project_deletion (from 20261017000076, plus the cascade setting) ==

-- Old overloads are long gone (0045 / 0064); defensive, so exactly one overload exists.
drop function if exists nopm_commit_project_deletion(uuid, uuid, text, uuid, text, text, text);
drop function if exists nopm_commit_project_deletion(uuid, uuid, text, uuid, text);

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
  v_approved_cr integer;
  v_approved_rb integer;
  v_doc_paths   jsonb;
  v_cr jsonb;
  v_dec jsonb;
  v_doc jsonb;
  v_sig jsonb;
  v_rb jsonb;
  v_cascade jsonb;
  v_child_ids uuid[];
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

  -- Tier role (0100): the approver must meet the request's tier. Same helper and message as the deletion_requests trigger,
  -- raised here so the refusal names the tier's role before anything is deleted.
  if not nopm_principal_meets_tier(p_workspace_id, r.tier, p_approver_principal_id) then
    raise exception 'ROLE_NOT_PERMITTED: only %s can approve a % request', nopm_tier_required_role(p_workspace_id, r.tier), r.tier using errcode = 'P0018';
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

  -- 0076 (owner decision 20, 2026-10-17): a project whose plan was changed by an
  -- APPROVED change request or by an approved / applied rebaseline carries
  -- decisions people signed. Deleting it would erase that record, so the
  -- deletion is refused (P0022) until those are gone. Checked after the project
  -- row lock above, so nothing can be approved between this count and the delete.
  select count(*) into v_approved_cr from change_requests
    where project_id = r.target_id and workspace_id = p_workspace_id and status in ('approved', 'implemented');
  select count(*) into v_approved_rb from rebaselines
    where project_id = r.target_id and workspace_id = p_workspace_id and status::text in ('approved', 'applied');
  if v_approved_cr > 0 or v_approved_rb > 0 then
    raise exception 'PROJECT_HAS_APPROVED_RECORDS: % approved change request(s) and % approved or applied rebaseline(s)', v_approved_cr, v_approved_rb
      using errcode = 'P0022';
  end if;

  -- 0076 (decision 20): the stored files of the project's documents, read BEFORE
  -- the cascade removes the rows, so the caller can delete the objects after commit.
  select coalesce(jsonb_agg(dc.storage_path), '[]'::jsonb) into v_doc_paths
    from documents dc
   where dc.project_id = r.target_id and dc.workspace_id = p_workspace_id and dc.storage_path is not null;

  -- 0102 (W4-12): everything the cascade removes is READ first and audited AFTER the delete. The audit insert
  -- takes the per-workspace advisory lock (0104) until commit, so it must come last: a writer that holds a row
  -- lock and then waits on that lock would otherwise deadlock with the cascade. Same transaction throughout.
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_cr from change_requests c
    where c.project_id = r.target_id and c.workspace_id = p_workspace_id;
  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) into v_dec from decisions d
    where d.project_id = r.target_id and d.workspace_id = p_workspace_id;
  select coalesce(jsonb_agg(to_jsonb(dc)), '[]'::jsonb) into v_doc from documents dc
    where dc.project_id = r.target_id and dc.workspace_id = p_workspace_id;
  select coalesce(jsonb_agg(to_jsonb(sg)), '[]'::jsonb) into v_sig from rebaseline_signoffs sg
    where sg.workspace_id = p_workspace_id
      and sg.rebaseline_id in (select id from rebaselines where project_id = r.target_id and workspace_id = p_workspace_id);
  select coalesce(jsonb_agg(to_jsonb(rb)), '[]'::jsonb) into v_rb from rebaselines rb
    where rb.project_id = r.target_id and rb.workspace_id = p_workspace_id;

  -- W4-11: counts and ids of the records the cascade removes that have no row audit of their own, written
  -- into the one project.delete row (no per-row audit rows).
  v_cascade := jsonb_build_object(
    'tasks',      (select jsonb_build_object('count', count(*), 'ids', coalesce(jsonb_agg(x.id), '[]'::jsonb)) from tasks x where x.project_id = r.target_id and x.workspace_id = p_workspace_id),
    'milestones', (select jsonb_build_object('count', count(*), 'ids', coalesce(jsonb_agg(x.id), '[]'::jsonb)) from milestones x where x.project_id = r.target_id and x.workspace_id = p_workspace_id),
    'risks',      (select jsonb_build_object('count', count(*), 'ids', coalesce(jsonb_agg(x.id), '[]'::jsonb)) from risks x where x.project_id = r.target_id and x.workspace_id = p_workspace_id),
    'issues',     (select jsonb_build_object('count', count(*), 'ids', coalesce(jsonb_agg(x.id), '[]'::jsonb)) from issues x where x.project_id = r.target_id and x.workspace_id = p_workspace_id),
    'expenses',   (select jsonb_build_object('count', count(*), 'ids', coalesce(jsonb_agg(x.id), '[]'::jsonb)) from expenses x where x.project_id = r.target_id and x.workspace_id = p_workspace_id)
  );

  -- W4-28: ids of every child that may have its own pending deletion request.
  select coalesce(array_agg(u.id), '{}'::uuid[]) into v_child_ids from (
    select id from tasks where project_id = r.target_id and workspace_id = p_workspace_id
    union all select id from risks where project_id = r.target_id and workspace_id = p_workspace_id
    union all select id from issues where project_id = r.target_id and workspace_id = p_workspace_id
    union all select id from expenses where project_id = r.target_id and workspace_id = p_workspace_id
    union all select id from documents where project_id = r.target_id and workspace_id = p_workspace_id
    union all select id from milestones where project_id = r.target_id and workspace_id = p_workspace_id
  ) u;

  -- 1. delete the target project (cascades milestones/tasks/risks/issues/
  --    clashes/budget/documents/change-control/rebaselines — all FK'd
  --    `on delete cascade` from projects(id)). No nopm.lock_bypass needed —
  --    see 0032 header note: the project row is confirmed unlocked above, and
  --    by the time cascaded child rows fire their own BEFORE DELETE triggers
  --    the parent project row is already gone, so 0028's null-safe lookup
  --    skips enforcement on its own.
  -- 0102: the cascade removes risks, issues, expenses, documents and milestones; their BEFORE DELETE
  -- backstop (nopm_refuse_direct_delete) lets this transaction through.
  perform set_config('nopm.deletion_commit', 'on', true);
  delete from projects where id = r.target_id and workspace_id = p_workspace_id;
  -- 0056: nothing deleted = nothing to commit or audit (project already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the project no longer exists, so there is nothing to delete'
      using errcode = 'P0017';
  end if;

  -- 0064 (D2) cascade audit rows, now written after the delete from the rows read above (W4-12).
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'change_request.cascade_delete', 'change_request', (e ->> 'id')::uuid, e,
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from jsonb_array_elements(v_cr) e;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'decision.cascade_delete', 'decision', (e ->> 'id')::uuid, e,
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from jsonb_array_elements(v_dec) e;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'document.cascade_delete', 'document', (e ->> 'id')::uuid, e,
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from jsonb_array_elements(v_doc) e;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'rebaseline_signoff.cascade_delete', 'rebaseline_signoff', (e ->> 'id')::uuid, e,
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from jsonb_array_elements(v_sig) e;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'rebaseline.cascade_delete', 'rebaseline', (e ->> 'id')::uuid, e,
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from jsonb_array_elements(v_rb) e;

  -- W4-28: a child's own pending deletion request is closed with the project, one audit row each.
  with closed as (
    update deletion_requests set status = 'withdrawn', decided_at = ts, closed_reason = 'parent_deleted'
     where workspace_id = p_workspace_id and status = 'pending' and id <> p_request_id
       and target_type in ('task', 'risk', 'issue', 'expense', 'document', 'milestone')
       and target_id = any (v_child_ids)
    returning id, target_type, target_id
  )
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'deletion_request.withdrawn', 'deletion_request', c.id,
           jsonb_build_object('status', 'pending'),
           jsonb_build_object('status', 'withdrawn', 'closed_reason', 'parent_deleted', 'project_id', r.target_id, 'target_type', c.target_type, 'target_id', c.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from closed c;

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
            'project.delete', r.target_type, r.target_id, r.before, jsonb_build_object('cascade_deleted', v_cascade), p_channel, p_correlation_id,
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
    'target_id', r.target_id,
    'document_paths', v_doc_paths
  );
end;
$$;

revoke execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

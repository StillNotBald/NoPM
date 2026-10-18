-- NoPM · 0076 (2026-10-17) — governance flow answers (owner decisions 20 and 24, Q-GOV-3/7/9/18/20).
--
-- WHAT.
--   1. deletion_requests.closed_reason (new, nullable): why a pending request was
--      closed by the system rather than decided ('target_gone' | 'project_locked').
--      Lets the screens say "closed - record gone" instead of a bare "withdrawn".
--   2. nopm_lock_project (latest body: 0072, copied verbatim) gains one guard: an
--      already locked project is returned untouched with already_locked = true; it
--      keeps its first locked_by / locked_at / lock_reason and writes no audit row
--      (nothing was mutated) (Q-GOV-9).
--   3. nopm_commit_project_deletion (latest body: 0072, copied verbatim) gains two
--      things (decision 20): it REFUSES (P0022 PROJECT_HAS_APPROVED_RECORDS) while
--      the project has approved change requests or approved / applied rebaselines,
--      and it returns document_paths (the stored files of the project's documents,
--      read before the cascade) so the caller can delete the objects after commit.
--   4. nopm_transition_change_request (new): the two audited status moves that are
--      not a decision - a manager/admin starts review (raised -> under_review,
--      Q-GOV-3), the requester or a manager/admin reopens a deferred request
--      (deferred -> under_review, decision 24). Change and audit row are one
--      transaction (Q-GOV-23).
--   5. nopm_withdraw_rebaseline (new): the proposer withdraws their own rebaseline
--      while it awaits sign-off (pending_approval -> cancelled, Q-GOV-7).
--
-- NEW ERRCODES (all unused before): P0022 PROJECT_HAS_APPROVED_RECORDS,
--   P0023 NOT_REQUESTER, P0024 INVALID_TRANSITION.
--
-- BACKWARD COMPATIBLE: an additive column, two function bodies that only add a
-- guard / a returned key, two new functions. The previous build keeps working
-- (it ignores the new key and never calls the new functions).
-- ROLLBACK. Re-apply the 0072 bodies of nopm_lock_project and
-- nopm_commit_project_deletion; drop function nopm_transition_change_request(...),
-- nopm_withdraw_rebaseline(...); alter table deletion_requests drop column closed_reason.

alter table deletion_requests add column if not exists closed_reason text;

comment on column deletion_requests.closed_reason is
  'Why a pending request was closed by the system instead of decided: target_gone (the record was already deleted) or project_locked (the project was locked after the request). NULL for every decided or withdrawn request.';

-- == nopm_lock_project (from 20261017000063) ==

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

  -- 0076 (Q-GOV-9): locking an already locked project does nothing. The first
  -- lock keeps its who / when / why, no second snapshot is taken and no audit row
  -- is written (nothing was mutated). The caller sees already_locked = true.
  if v_before.is_locked then
    return to_jsonb(v_before) || jsonb_build_object('already_locked', true);
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

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'project.lock', 'project', p_project_id,
            to_jsonb(v_before),
            to_jsonb(v_after) || jsonb_build_object('project_baseline', jsonb_build_object(
              'before', jsonb_build_object('start', v_before.baseline_start_date, 'target', v_before.baseline_target_date),
              'after',  jsonb_build_object('start', v_after.baseline_start_date,  'target', v_after.baseline_target_date))),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, nopm_audit_principal(p_workspace_id, p_actor_type, p_actor_id));

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_lock_project(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_lock_project(uuid, uuid, text, text, uuid, text, text, text, uuid, text, text) to service_role;
-- == nopm_commit_project_deletion (from 20261017000064) ==

-- Same stale-overload guard as 0064 (a no-op: that signature is already gone).
drop function if exists nopm_commit_project_deletion(uuid, uuid, text, uuid, text, text, text);

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

  -- 0064 (D2): the cascade below destroys governed records. Their audit rows are
  -- written HERE, in the same transaction, from the rows as they are right now
  -- (the delete has not run yet): one row per change request, decision,
  -- document, rebaseline and rebaseline sign-off, each carrying its full row in
  -- `before` (a document's row keeps its storage_path, so an orphaned file can
  -- be traced). If the delete below finds nothing, the whole transaction rolls
  -- back and so do these rows.
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'change_request.cascade_delete', 'change_request', c.id, to_jsonb(c),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from change_requests c where c.project_id = r.target_id and c.workspace_id = p_workspace_id;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'decision.cascade_delete', 'decision', d.id, to_jsonb(d),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from decisions d where d.project_id = r.target_id and d.workspace_id = p_workspace_id;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'document.cascade_delete', 'document', dc.id, to_jsonb(dc),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from documents dc where dc.project_id = r.target_id and dc.workspace_id = p_workspace_id;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'rebaseline_signoff.cascade_delete', 'rebaseline_signoff', s.id, to_jsonb(s),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from rebaseline_signoffs s where s.workspace_id = p_workspace_id and s.rebaseline_id in (select id from rebaselines where project_id = r.target_id and workspace_id = p_workspace_id);
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'rebaseline.cascade_delete', 'rebaseline', rb.id, to_jsonb(rb),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref, p_approver_principal_id
      from rebaselines rb where rb.project_id = r.target_id and rb.workspace_id = p_workspace_id;

  -- 1. delete the target project (cascades milestones/tasks/risks/issues/
  --    clashes/budget/documents/change-control/rebaselines — all FK'd
  --    `on delete cascade` from projects(id)). No nopm.lock_bypass needed —
  --    see 0032 header note: the project row is confirmed unlocked above, and
  --    by the time cascaded child rows fire their own BEFORE DELETE triggers
  --    the parent project row is already gone, so 0028's null-safe lookup
  --    skips enforcement on its own.
  delete from projects where id = r.target_id and workspace_id = p_workspace_id;
  -- 0056: nothing deleted = nothing to commit or audit (project already gone).
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'TARGET_GONE: the project no longer exists, so there is nothing to delete'
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
            'project.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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
-- == nopm_transition_change_request (new) ==

create or replace function nopm_transition_change_request(
  p_id                 uuid,
  p_workspace_id       uuid,
  p_action             text,
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
  if p_action not in ('start_review', 'reopen') then
    raise exception 'INVALID_ACTION' using errcode = 'P0001';
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

  if p_action = 'start_review' then
    -- Only a manager or admin moves a request into review.
    if v_role is null or v_role not in ('admin', 'manager') then
      raise exception 'ROLE_NOT_PERMITTED: only managers and admins can start a review' using errcode = 'P0018';
    end if;
    if cr.status <> 'raised' then
      raise exception 'INVALID_TRANSITION: status is %', cr.status using errcode = 'P0024';
    end if;
    update change_requests set status = 'under_review'
     where id = p_id and workspace_id = p_workspace_id
    returning * into v_after;
  else
    -- Reopen: a deferred request is parked, not closed. The requester (the person
    -- behind it) or a manager / admin brings it back. The earlier defer decision
    -- is cleared from the row (the audit row keeps it in `before`).
    if cr.status <> 'deferred' then
      raise exception 'INVALID_TRANSITION: status is %', cr.status using errcode = 'P0024';
    end if;
    if not (
         (v_role is not null and v_role in ('admin', 'manager'))
      or (cr.requested_principal_id is not null and cr.requested_principal_id = p_principal_id)
      or (cr.requested_by is not null and cr.requested_by = p_principal_id)
    ) then
      raise exception 'NOT_REQUESTER: only the requester or a manager or admin can reopen this' using errcode = 'P0023';
    end if;
    update change_requests set
      status               = 'under_review',
      decided_by           = null,
      decided_by_label     = null,
      decided_by_type      = null,
      decided_by_id        = null,
      decided_principal_id = null,
      decision_rationale   = null,
      decided_at           = null
    where id = p_id and workspace_id = p_workspace_id
    returning * into v_after;
  end if;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            case when p_action = 'start_review' then 'change_request.start_review' else 'change_request.reopen' end,
            'change_request', p_id,
            to_jsonb(cr), to_jsonb(v_after),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_principal_id);

  return to_jsonb(v_after);
end;
$$;

revoke execute on function nopm_transition_change_request(uuid, uuid, text, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_transition_change_request(uuid, uuid, text, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;

-- == nopm_withdraw_rebaseline (new) ==

create or replace function nopm_withdraw_rebaseline(
  p_rebaseline_id      uuid,
  p_workspace_id       uuid,
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
  r       rebaselines%rowtype;
  v_after rebaselines%rowtype;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if p_principal_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;

  select * into r from rebaselines
    where id = p_rebaseline_id and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- Only the proposer (the person behind it) withdraws: withdrawing decides
  -- nothing, so the four-eyes rule that bars them from signing does not apply.
  if not (
       (r.requested_principal_id is not null and r.requested_principal_id = p_principal_id)
    or (r.requested_by is not null and r.requested_by = p_actor_id)
  ) then
    raise exception 'NOT_REQUESTER: only the person who proposed this rebaseline can withdraw it' using errcode = 'P0023';
  end if;
  if r.status::text <> 'pending_approval' then
    raise exception 'ALREADY_DECIDED: rebaseline status is %', r.status using errcode = 'P0001';
  end if;

  update rebaselines set status = 'cancelled'
   where id = p_rebaseline_id and workspace_id = p_workspace_id
  returning * into v_after;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref, principal_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'rebaseline.withdrawn', 'rebaseline', p_rebaseline_id,
            to_jsonb(r) - 'baseline_before',
            (to_jsonb(v_after) - 'baseline_before') || jsonb_build_object('reason', 'withdrawn_by_proposer'),
            p_channel, p_correlation_id,
            p_via_connector_id, p_external_event_id, p_external_actor_ref, p_principal_id);

  return to_jsonb(v_after) - 'baseline_before';
end;
$$;

revoke execute on function nopm_withdraw_rebaseline(uuid, uuid, text, uuid, text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_withdraw_rebaseline(uuid, uuid, text, uuid, text, uuid, text, text, uuid, text, text) to service_role;


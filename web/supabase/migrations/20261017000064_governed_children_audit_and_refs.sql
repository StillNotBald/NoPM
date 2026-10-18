-- NoPM · 0064 governed_children_audit_and_refs (2026-10-17)
--
-- 1. D2 / A3-8. Approving a project deletion cascades to the project's change
--    requests, decisions, documents, rebaselines and sign-offs, but the audit
--    trail only said "project.delete". nopm_commit_project_deletion() now also
--    writes one `<type>.cascade_delete` audit row per such record, in the same
--    transaction. The function is the 0056 body, unchanged otherwise (every
--    guard, the grant and the signature are identical); only the block marked
--    0064 is new.
-- 2. D9 / Q-GOV-16. CR-/DEC-/DOC- reference numbers must never repeat. Numbers
--    came from "highest left on the table + 1", so deleting the newest record
--    freed its number. nopm_ref_counters + nopm_next_ref() hand out numbers from
--    a per-workspace counter that only goes up (seeded from the highest number
--    already in the table; race-safe through the upsert's row lock). A unique
--    index per register is the backstop, created only when no duplicates exist.
-- ROLLBACK. Restore the 0056 body of nopm_commit_project_deletion(); remove
--           nopm_next_ref(uuid, text), the nopm_ref_counters table and the three
--           uniq_*_reference indexes.

-- == 1. cascade audit =========================================================

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

  -- 0064 (D2): the cascade below destroys governed records. Their audit rows are
  -- written HERE, in the same transaction, from the rows as they are right now
  -- (the delete has not run yet): one row per change request, decision,
  -- document, rebaseline and rebaseline sign-off, each carrying its full row in
  -- `before` (a document's row keeps its storage_path, so an orphaned file can
  -- be traced). If the delete below finds nothing, the whole transaction rolls
  -- back and so do these rows.
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'change_request.cascade_delete', 'change_request', c.id, to_jsonb(c),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref
      from change_requests c where c.project_id = r.target_id and c.workspace_id = p_workspace_id;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'decision.cascade_delete', 'decision', d.id, to_jsonb(d),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref
      from decisions d where d.project_id = r.target_id and d.workspace_id = p_workspace_id;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'document.cascade_delete', 'document', dc.id, to_jsonb(dc),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref
      from documents dc where dc.project_id = r.target_id and dc.workspace_id = p_workspace_id;
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'rebaseline_signoff.cascade_delete', 'rebaseline_signoff', s.id, to_jsonb(s),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref
      from rebaseline_signoffs s where s.workspace_id = p_workspace_id and s.rebaseline_id in (select id from rebaselines where project_id = r.target_id and workspace_id = p_workspace_id);
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    select p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
           'rebaseline.cascade_delete', 'rebaseline', rb.id, to_jsonb(rb),
           jsonb_build_object('deleted_with_project', r.target_id),
           p_channel, p_correlation_id, p_via_connector_id, p_external_event_id, p_external_actor_ref
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
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'project.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id,
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

revoke execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text) to service_role;

-- == 2. never-reused reference numbers ========================================

create table if not exists nopm_ref_counters (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind         text not null check (kind in ('change_request', 'decision', 'document')),
  last_value   integer not null default 0,
  primary key (workspace_id, kind)
);
alter table nopm_ref_counters enable row level security;  -- no policy: service role only

create or replace function nopm_next_ref(p_workspace_id uuid, p_kind text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_prefix text;
  v_table  text;
  v_max    integer;
  v_next   integer;
begin
  case p_kind
    when 'change_request' then v_prefix := 'CR';  v_table := 'change_requests';
    when 'decision'       then v_prefix := 'DEC'; v_table := 'decisions';
    when 'document'       then v_prefix := 'DOC'; v_table := 'documents';
    else raise exception 'INVALID_KIND' using errcode = 'P0005';
  end case;

  -- Highest number still on the table: only used to seed or catch up a counter.
  execute format(
    'select coalesce(max(substring(reference_id from ''([0-9]+)$'')::bigint), 0)
       from %I where workspace_id = $1 and reference_id ~ ''^[A-Z]+-[0-9]{1,9}$''', v_table)
    into v_max using p_workspace_id;

  insert into nopm_ref_counters as c (workspace_id, kind, last_value)
    values (p_workspace_id, p_kind, v_max + 1)
  on conflict (workspace_id, kind)
    do update set last_value = greatest(c.last_value, v_max) + 1
  returning c.last_value into v_next;

  return v_prefix || '-' || lpad(v_next::text, 3, '0');
end;
$$;

revoke execute on function nopm_next_ref(uuid, text) from public, anon, authenticated;
grant  execute on function nopm_next_ref(uuid, text) to service_role;

-- Backstop: unique per workspace, only where no duplicates exist today.
do $$
begin
  if exists (select 1 from change_requests where reference_id is not null group by workspace_id, reference_id having count(*) > 1) then
    raise notice '0064: duplicate change_requests.reference_id found; skipping uniq_change_requests_reference';
  else
    create unique index if not exists uniq_change_requests_reference on change_requests (workspace_id, reference_id) where reference_id is not null;
  end if;
  if exists (select 1 from decisions where reference_id is not null group by workspace_id, reference_id having count(*) > 1) then
    raise notice '0064: duplicate decisions.reference_id found; skipping uniq_decisions_reference';
  else
    create unique index if not exists uniq_decisions_reference on decisions (workspace_id, reference_id) where reference_id is not null;
  end if;
  if exists (select 1 from documents where reference_id is not null group by workspace_id, reference_id having count(*) > 1) then
    raise notice '0064: duplicate documents.reference_id found; skipping uniq_documents_reference';
  else
    create unique index if not exists uniq_documents_reference on documents (workspace_id, reference_id) where reference_id is not null;
  end if;
end
$$;

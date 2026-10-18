-- NoPM · 0020 atomic four-eyes deletion commit.
--
-- The approve route previously did FOUR separate non-transactional writes
-- (delete task → update request → audit task.delete → audit approved). A crash
-- between the delete and the audit inserts could leave a committed deletion with
-- ZERO audit rows — the governance showpiece losing its own evidence. This wraps
-- the whole commit in ONE transaction (a function body is atomic), and locks the
-- request row FOR UPDATE so two approvers can't double-commit (TOCTOU).
--
-- Guards raise typed exceptions the API maps to 404 / 422 / 403:
--   NOT_FOUND       — no such pending request in this workspace
--   ALREADY_DECIDED — request is not 'pending'
--   SELF_APPROVAL   — approver is the requester (four-eyes)

create or replace function nopm_commit_task_deletion(
  p_request_id     uuid,
  p_workspace_id   uuid,
  p_approver_type  text,
  p_approver_id    uuid,
  p_approver_label text
) returns jsonb
language plpgsql
as $$
declare
  r  deletion_requests%rowtype;
  ts timestamptz := now();
begin
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

  -- 1. delete the target (only 'task' supported today)
  if r.target_type = 'task' then
    delete from tasks where id = r.target_id and workspace_id = p_workspace_id;
  end if;

  -- 2. commit the deletion request
  update deletion_requests set
    status            = 'committed',
    approved_by_type  = p_approver_type::actor_type,
    approved_by_id    = p_approver_id,
    approved_by_label = p_approver_label,
    decided_at        = ts,
    committed_at      = ts
  where id = p_request_id and workspace_id = p_workspace_id;

  -- 3. audit the deletion (before = snapshot captured at request time)
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'task.delete', r.target_type, r.target_id, r.before, null);

  -- 4. audit the governance step itself
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'deletion_request.approved', 'deletion_request', r.id,
            jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'committed'));

  return jsonb_build_object(
    'committed', true,
    'request_id', r.id,
    'requested_by_id', r.requested_by_id,
    'target_type', r.target_type,
    'target_id', r.target_id
  );
end;
$$;

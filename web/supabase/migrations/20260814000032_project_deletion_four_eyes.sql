-- NoPM · 0032 — project deletion four-eyes commit RPC.
--
-- Owner-locked (Decision 3, requirements/devops-wave1/README.md): maker-checker
-- extends to PROJECTS ONLY. Milestones/risks/issues stay audit-only hard-delete
-- (the asymmetry is intentional and documented there) — this migration does
-- NOT touch that.
--
-- Modeled faithfully on nopm_commit_task_deletion (migration 0020): the whole
-- commit (delete + request update + BOTH audit rows) runs in ONE transaction,
-- with the deletion_requests row locked FOR UPDATE so two approvers can't
-- double-commit (TOCTOU), and the same three typed guards (NOT_FOUND /
-- ALREADY_DECIDED / SELF_APPROVAL) map to the same errcodes so the existing
-- API error-mapping pattern (see approve/route.ts) needs no new branches for
-- those three.
--
-- KNOWN TRAP (do not repeat here): nopm_commit_task_deletion hardcodes both
-- the `tasks` table and the audit action string 'task.delete'. This function
-- is a DEDICATED SIBLING for projects — it hardcodes the `projects` table and
-- the audit action string 'project.delete'. Do NOT try to merge the two into
-- one parameterized function; that was rejected specifically because the
-- audit action string must stay a compile-time-visible literal per entity
-- type, not a runtime-interpolated value.
--
-- PROJECT_LOCKED (new vs. 0020): a locked project's schedule shape is frozen
-- (migration 0028's DB backstop). Deleting a locked project would cascade
-- into deleting its tasks/milestones, which the 0028 trigger would reject
-- mid-cascade with P0010 — so this function checks is_locked itself, BEFORE
-- attempting the delete, and fails cleanly and early with the same P0010
-- errcode 0028 uses (so the approve route's existing `error.code === 'P0010'`
-- branch already maps it to a 422 RuleError with no new code needed).
--
-- ORDERING — why no nopm.lock_bypass is needed here (unlike
-- nopm_apply_rebaseline_snapshot in 0028, which sets the bypass because it
-- legitimately writes schedule-shape columns on an intentionally-still-locked
-- project): by the time this function reaches the delete, is_locked has
-- already been confirmed false, so the 0028 triggers would not fire anyway on
-- an unlocked project's children. The delete is issued as
-- `delete from projects ...` and the ON DELETE CASCADE removes its
-- tasks/milestones/etc. as part of the SAME statement. nopm_reject_if_project_
-- locked() (0028) is already null-safe by design ("a resolved project id can
-- be null ... in which case there is nothing left to check") — and by the
-- time each cascaded child row's BEFORE DELETE trigger fires, the parent
-- projects row has already been removed within this transaction (Postgres
-- cascade actions run as row-level AFTER triggers via SPI, which see prior
-- writes of the same transaction), so `select is_locked into v_locked from
-- projects where id = p_project_id` finds no row, v_locked stays NULL, and
-- `if v_locked then` — null is falsy — does not raise. So: check is_locked
-- once up front, then a single unconditional `delete from projects`, no
-- bypass GUC touched. This deliberately keeps nopm.lock_bypass's contract
-- ("No other code path sets this GUC", per 0028's header) intact.
--
-- Guards raise typed exceptions the API maps to 404 / 422 / 403:
--   NOT_FOUND       — no such pending request in this workspace       (P0002)
--   ALREADY_DECIDED — request is not 'pending'                        (P0001)
--   SELF_APPROVAL   — approver is the requester (four-eyes)           (P0003)
--   PROJECT_LOCKED  — target project's schedule is frozen             (P0010)

create or replace function nopm_commit_project_deletion(
  p_request_id     uuid,
  p_workspace_id   uuid,
  p_approver_type  text,
  p_approver_id    uuid,
  p_approver_label text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r          deletion_requests%rowtype;
  ts         timestamptz := now();
  v_locked   boolean;
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

  -- A locked project's schedule shape is frozen (0028) — a cascaded child
  -- delete would trip that backstop mid-transaction anyway; fail cleanly and
  -- early instead of letting the cascade discover it.
  select is_locked into v_locked from projects
    where id = r.target_id and workspace_id = p_workspace_id;
  if v_locked then
    raise exception 'PROJECT_LOCKED: project schedule is frozen — unlock the project or apply a rebaseline before deleting it'
      using errcode = 'P0010';
  end if;

  -- 1. delete the target project (cascades milestones/tasks/risks/issues/
  --    clashes/budget/documents/change-control/rebaselines — all FK'd
  --    `on delete cascade` from projects(id)). No nopm.lock_bypass needed —
  --    see header note: the project row is confirmed unlocked above, and by
  --    the time cascaded child rows fire their own BEFORE DELETE triggers the
  --    parent project row is already gone, so 0028's null-safe lookup skips
  --    enforcement on its own.
  delete from projects where id = r.target_id and workspace_id = p_workspace_id;

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
            'project.delete', r.target_type, r.target_id, r.before, null);

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

revoke execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant  execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text) to service_role;

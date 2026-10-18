-- NoPM · 0044 rpc_audit_provenance (R-84).
--
-- R-82 (migration 0042) gave audit_log two provenance columns — channel and
-- request_id — and wired every route() writer (writeAudit, via
-- resolveClientMeta/resolveRequestId) to stamp them. But three functions
-- write audit_log rows DIRECTLY, inside their own atomic transaction, never
-- going through writeAudit: nopm_commit_task_deletion (0020), nopm_commit_
-- project_deletion (0032), nopm_accept_invite (0039). Every row those three
-- write today carries channel = NULL, request_id = NULL — a provenance gap
-- in exactly the rows that matter most (deletion commits, identity
-- provisioning). This migration closes it.
--
-- WHY DROP + CREATE OR REPLACE (not just CREATE OR REPLACE): Postgres
-- overloads functions by (name, parameter type list) — adding two new
-- parameters, even with DEFAULT NULL, gives each function a genuinely
-- different signature, not a like-for-like replacement. `create or replace`
-- alone would leave the OLD 5-arg signature registered as a still-callable
-- overload beside the new 7-arg one — exactly the footgun 0032's header
-- warned about avoiding elsewhere. `drop function if exists <old sig>` first
-- guarantees the old arity is gone and every caller goes through the one
-- provenance-carrying signature.
--
-- PARAMETER NAMING — p_correlation_id, not p_request_id: nopm_commit_task_
-- deletion and nopm_commit_project_deletion already have a parameter named
-- p_request_id (the deletion_requests row id being committed — an
-- unrelated, pre-existing uuid). The task brief for this migration called
-- the new correlation parameter "p_request_id" on all three functions, but
-- literally adding a second same-named parameter to those two would be a
-- Postgres compile error (and, if worked around some other way, a silent
-- caller-object key collision in the two TS call sites, since both would
-- write into the same `p_request_id` object key). All three functions here
-- instead take p_channel + p_correlation_id — one consistent pair of names
-- across all three RPCs, no collision, same audit_log.request_id column on
-- the write side.
--
-- Bodies below are copied verbatim from the LATEST definition of each
-- function (0020+0023 for task deletion, 0032 for project deletion, 0039 for
-- invite accept) with three additions only: (1) the two new trailing
-- parameters, (2) an INVALID_CHANNEL guard at the top of the body — a
-- CHECK-equivalent belt-and-suspenders alongside audit_log's own
-- audit_channel_check constraint (0042), so a bad channel value fails inside
-- the RPC's own transaction with a typed error instead of surfacing as a
-- generic constraint-violation 500, and (3) `channel, request_id` columns +
-- `p_channel, p_correlation_id` values on every audit_log insert. Grant/
-- revoke posture (service_role only) and security definer / search_path
-- clauses are re-applied exactly as the latest definition had them.

-- ── 1. nopm_commit_task_deletion (latest body: 0020 + 0023's search_path) ──

drop function if exists nopm_commit_task_deletion(uuid, uuid, text, uuid, text);

create or replace function nopm_commit_task_deletion(
  p_request_id     uuid,
  p_workspace_id   uuid,
  p_approver_type  text,
  p_approver_id    uuid,
  p_approver_label text,
  p_channel        text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r  deletion_requests%rowtype;
  ts timestamptz := now();
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
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
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'task.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id);

  -- 4. audit the governance step itself
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'deletion_request.approved', 'deletion_request', r.id,
            jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'committed'),
            p_channel, p_correlation_id);

  return jsonb_build_object(
    'committed', true,
    'request_id', r.id,
    'requested_by_id', r.requested_by_id,
    'target_type', r.target_type,
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text, text, text) to service_role;

-- ── 2. nopm_commit_project_deletion (latest body: 0032) ──────────────────

drop function if exists nopm_commit_project_deletion(uuid, uuid, text, uuid, text);

create or replace function nopm_commit_project_deletion(
  p_request_id     uuid,
  p_workspace_id   uuid,
  p_approver_type  text,
  p_approver_id    uuid,
  p_approver_label text,
  p_channel        text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  r          deletion_requests%rowtype;
  ts         timestamptz := now();
  v_locked   boolean;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
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
  --    see 0032 header note: the project row is confirmed unlocked above, and
  --    by the time cascaded child rows fire their own BEFORE DELETE triggers
  --    the parent project row is already gone, so 0028's null-safe lookup
  --    skips enforcement on its own.
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
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'project.delete', r.target_type, r.target_id, r.before, null, p_channel, p_correlation_id);

  -- 4. audit the governance step itself
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (p_workspace_id, p_approver_type::actor_type, p_approver_id, p_approver_label,
            'deletion_request.approved', 'deletion_request', r.id,
            jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'committed'),
            p_channel, p_correlation_id);

  return jsonb_build_object(
    'committed', true,
    'request_id', r.id,
    'requested_by_id', r.requested_by_id,
    'target_type', r.target_type,
    'target_id', r.target_id
  );
end;
$$;

revoke execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant  execute on function nopm_commit_project_deletion(uuid, uuid, text, uuid, text, text, text) to service_role;

-- ── 3. nopm_accept_invite (latest body: 0039) ────────────────────────────
-- No p_request_id naming collision here (invite-accept has no pre-existing
-- request-id parameter) but p_correlation_id is used anyway, for one
-- consistent pair of provenance parameter names across all three functions
-- in this migration.

drop function if exists nopm_accept_invite(text, uuid, text, text);

create or replace function nopm_accept_invite(
  p_token_hash     text,
  p_auth_user_id   uuid,
  p_email          text,
  p_display_name   text,
  p_channel        text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inv       invites%rowtype;
  ts        timestamptz := now();
  v_member_id uuid;
  v_label   text := coalesce(nullif(trim(p_display_name), ''), p_email);
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;

  select * into inv from invites where token_hash = p_token_hash for update;

  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if inv.revoked or inv.accepted_at is not null then
    raise exception 'ALREADY_USED' using errcode = 'P0001';
  end if;
  if inv.expires_at <= ts then
    raise exception 'EXPIRED' using errcode = 'P0004';
  end if;

  -- 1. login identity — profiles row, id = the auth.users id the caller
  --    already created. role comes from the invite, never the request body.
  insert into profiles (id, workspace_id, email, display_name, role)
    values (p_auth_user_id, inv.workspace_id, p_email, p_display_name, inv.role);

  -- 2. work identity — resource_members row bridged to the login identity
  --    via profile_id (recon-identity.md §1 — the FK the 0019 failure mode
  --    left unenforced). name falls back to the display name the accepter
  --    chose if the inviter never set one.
  insert into resource_members (
    workspace_id, name, email, role_title, cost_rate, capacity_hours_per_week, profile_id
  ) values (
    inv.workspace_id,
    coalesce(inv.name, p_display_name),
    p_email,
    inv.role_title,
    inv.cost_rate,
    inv.capacity_hours_per_week,
    p_auth_user_id
  )
  returning id into v_member_id;

  -- 3. mark the invite consumed.
  update invites set accepted_at = ts, accepted_profile_id = p_auth_user_id where id = inv.id;

  -- 4/5. two audit rows — the domain effect (a new member joined) audited
  -- separately from the governance step itself (the invite being consumed),
  -- same two-row pattern as the deletion commit RPCs (migrations 0020/0032).
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (inv.workspace_id, 'user'::actor_type, p_auth_user_id, v_label,
            'invite.accepted', 'invite', inv.id,
            jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'accepted'),
            p_channel, p_correlation_id);

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (inv.workspace_id, 'user'::actor_type, p_auth_user_id, v_label,
            'member.joined', 'resource_member', v_member_id,
            null, jsonb_build_object('name', coalesce(inv.name, p_display_name), 'role', inv.role),
            p_channel, p_correlation_id);

  return jsonb_build_object(
    'profile_id', p_auth_user_id,
    'member_id', v_member_id,
    'workspace_id', inv.workspace_id
  );
end;
$$;

revoke execute on function nopm_accept_invite(text, uuid, text, text, text, text) from public, anon, authenticated;
grant  execute on function nopm_accept_invite(text, uuid, text, text, text, text) to service_role;

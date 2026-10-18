-- NoPM · 0045 principal_four_eyes (2026-10-16, owner decision D1).
--
-- THE BUG. Four-eyes compared ACTOR ids, not humans. A token actor's id is the
-- api_tokens row id, a session actor's id is the profile id — two disjoint
-- namespaces — so one person could raise a deletion request in the console and
-- approve it with a PAT they minted themselves (different id, different type),
-- or approve a change request / timesheet / rebaseline the same way. The only
-- DB guard was `requested_by_id = p_approver_id` and id-only CHECKs. api_tokens
-- .created_by (the human who minted a token) existed but was never consulted.
--
-- THE FIX. Every governed request now carries the HUMAN behind each side — the
-- "principal" (a profiles.id): a session user is their own principal, a PAT's
-- principal is api_tokens.created_by, a verified chat-connector click is the
-- linked profile. The checker's principal must differ from the maker's, and a
-- checker with NO principal (legacy token with no recorded creator) can never
-- decide anything (fail-closed). The API layer (src/lib/governance/decide.ts)
-- stamps the columns and compares; this migration is the DB backstop.
--
-- WHAT THIS MIGRATION DOES
--   1. Additive principal columns on the five governed tables (no FK on
--      purpose: like requested_by_id they are evidence, and must survive a
--      profile being deleted).
--   2. Backfill — retroactive for every actor (D1): user-actor rows take the
--      user id, token-actor rows take api_tokens.created_by, and token-raised
--      rebaselines (which stored no actor at all) are recovered from the
--      immutable audit_log 'rebaseline.create' row.
--   3. Principal-distinct CHECKs, added NOT VALID. NOT VALID still enforces on
--      every new and updated row but does not re-scan history: past decisions
--      that the new rule would have blocked (e.g. a request raised and approved
--      by the same human through two identities) stay on record as evidence
--      instead of failing the migration. A NOTICE below reports how many.
--   4. nopm_commit_task_deletion / nopm_commit_project_deletion recreated with
--      p_approver_principal_id (+ an optional approval note recorded in the
--      audit row, UC-12), and the previous overloads DROPPED: a still-callable
--      old signature would skip the principal check, i.e. a bypass.
--   5. The 0022 rebaseline sign-off trigger now compares principals.
--
-- CONNECTOR PROVENANCE: both RPCs also take p_via_connector_id /
-- p_external_event_id / p_external_actor_ref (all default null) and write them
-- on every audit_log row they insert, so a chat-card approval is as provable as
-- one made in the console. Those three audit_log columns are added by the
-- integration-hub migration (0046), which runs AFTER this one: PL/pgSQL
-- resolves column references when a statement first executes, not at CREATE
-- time, so this file is valid on its own and the functions only need 0046
-- applied before their first call. Nothing outside a function body references
-- them here.
--
-- LEGACY REQUESTS: a request whose stored requester principal is NULL (raised by
-- a token that had no recorded creator) cannot be compared by human, so it stays
-- approvable by any human principal — only the actor-id check applies. That is
-- deliberate: blocking it would strand those requests forever.
--
-- ERRCODES (mapped to HTTP by the API): P0003 SELF_APPROVAL -> 403,
-- P0006 NO_PRINCIPAL -> 403 (new), the rest unchanged from 0020/0032/0044.
-- Body of both RPCs = the LATEST definition (0044) + the additions above only.
-- 'lark' joins the accepted channels for the two deletion RPCs: a chat-card
-- approval is server-derived provenance (see src/lib/audit/channel.ts), and
-- audit_log's own channel CHECK is extended in the integration-hub migration
-- (0046) which ships in the same release.

-- ── 1. principal columns ──────────────────────────────────────────────────

alter table deletion_requests
  add column requested_principal_id uuid,
  add column approved_principal_id  uuid;

alter table change_requests
  add column requested_principal_id uuid,
  add column decided_principal_id   uuid;

alter table timesheet_submissions
  add column submitted_principal_id uuid,
  add column decided_principal_id   uuid;

alter table rebaselines
  add column requested_principal_id uuid;

alter table rebaseline_signoffs
  add column approver_principal_id uuid;

comment on column deletion_requests.requested_principal_id is
  'the HUMAN (profiles.id) behind the requester: the user id for a session actor, api_tokens.created_by for a token actor; NULL only for a legacy token with no recorded creator';
comment on column deletion_requests.approved_principal_id is
  'the HUMAN who approved/rejected; must differ from requested_principal_id (deletion_principal_distinct)';
comment on column change_requests.requested_principal_id is
  'the HUMAN behind the actor that raised the request (user id, or the token''s created_by)';
comment on column change_requests.decided_principal_id is
  'the HUMAN who decided; must differ from requested_principal_id (cr_principal_distinct)';
comment on column timesheet_submissions.submitted_principal_id is
  'the HUMAN behind the actor that submitted the sheet (user id, or the token''s created_by)';
comment on column timesheet_submissions.decided_principal_id is
  'the HUMAN who decided; must differ from submitted_principal_id (ts_principal_distinct)';
comment on column rebaselines.requested_principal_id is
  'the HUMAN behind the actor that raised the rebaseline (the legacy requested_by is user-only and NULL for tokens)';
comment on column rebaseline_signoffs.approver_principal_id is
  'the HUMAN who cast the vote. approver_id is the same profile (a token sign-off is cast as its owner), so a person has exactly one vote however many identities they hold';

-- ── 2. backfill (retroactive for every actor) ─────────────────────────────

-- The updated_at triggers on these two tables would stamp every backfilled row
-- "modified now", which is a lie (nothing about the request changed) and would
-- invalidate every cached updated_at. Paused for the backfill only.
alter table change_requests        disable trigger trg_change_requests_updated;
alter table timesheet_submissions  disable trigger trg_timesheet_submissions_updated;

-- deletion_requests: requester
update deletion_requests set requested_principal_id = requested_by_id
  where requested_by_type = 'user' and requested_principal_id is null;
update deletion_requests dr set requested_principal_id = t.created_by
  from api_tokens t
  where dr.requested_by_type = 'token' and dr.requested_by_id = t.id
    and dr.requested_principal_id is null and t.created_by is not null;
-- deletion_requests: decider (approved / rejected / committed rows only)
update deletion_requests set approved_principal_id = approved_by_id
  where approved_by_type = 'user' and approved_by_id is not null and approved_principal_id is null;
update deletion_requests dr set approved_principal_id = t.created_by
  from api_tokens t
  where dr.approved_by_type = 'token' and dr.approved_by_id = t.id
    and dr.approved_principal_id is null and t.created_by is not null;

-- change_requests
update change_requests set requested_principal_id = requested_by_id
  where requested_by_type = 'user' and requested_principal_id is null;
update change_requests cr set requested_principal_id = t.created_by
  from api_tokens t
  where cr.requested_by_type = 'token' and cr.requested_by_id = t.id
    and cr.requested_principal_id is null and t.created_by is not null;
update change_requests set decided_principal_id = decided_by_id
  where decided_by_type = 'user' and decided_by_id is not null and decided_principal_id is null;
update change_requests cr set decided_principal_id = t.created_by
  from api_tokens t
  where cr.decided_by_type = 'token' and cr.decided_by_id = t.id
    and cr.decided_principal_id is null and t.created_by is not null;

-- timesheet_submissions
update timesheet_submissions set submitted_principal_id = submitted_by
  where submitted_by_type = 'user' and submitted_principal_id is null;
update timesheet_submissions ts set submitted_principal_id = t.created_by
  from api_tokens t
  where ts.submitted_by_type = 'token' and ts.submitted_by = t.id
    and ts.submitted_principal_id is null and t.created_by is not null;
update timesheet_submissions set decided_principal_id = decided_by
  where decided_by_type = 'user' and decided_by is not null and decided_principal_id is null;
update timesheet_submissions ts set decided_principal_id = t.created_by
  from api_tokens t
  where ts.decided_by_type = 'token' and ts.decided_by = t.id
    and ts.decided_principal_id is null and t.created_by is not null;

-- rebaselines: user-raised rows already name a profile (requested_by) ...
update rebaselines set requested_principal_id = requested_by
  where requested_by is not null and requested_principal_id is null;
-- ... token-raised rows stored NO actor (requested_by is user-only), but the
-- immutable audit row written at creation names the token that raised it.
update rebaselines r set requested_principal_id = t.created_by
  from audit_log a
  join api_tokens t on t.id = a.actor_id
  where a.workspace_id = r.workspace_id
    and a.action = 'rebaseline.create'
    and a.target_type = 'rebaseline'
    and a.target_id = r.id
    and a.actor_type = 'token'
    and r.requested_principal_id is null
    and t.created_by is not null;

-- rebaseline_signoffs: approver_id has always been a profile id
update rebaseline_signoffs set approver_principal_id = approver_id
  where approver_principal_id is null;

alter table change_requests        enable trigger trg_change_requests_updated;
alter table timesheet_submissions  enable trigger trg_timesheet_submissions_updated;

-- ── 3. principal-distinct CHECKs (NOT VALID: enforce going forward) ───────

alter table deletion_requests
  add constraint deletion_principal_distinct check (
    approved_principal_id is null
    or requested_principal_id is null
    or approved_principal_id <> requested_principal_id
  ) not valid;

alter table change_requests
  add constraint cr_principal_distinct check (
    decided_principal_id is null
    or requested_principal_id is null
    or decided_principal_id <> requested_principal_id
  ) not valid;

alter table timesheet_submissions
  add constraint ts_principal_distinct check (
    decided_principal_id is null
    or submitted_principal_id is null
    or decided_principal_id <> submitted_principal_id
  ) not valid;

-- One vote per human per rebaseline. The sign-off route has always upserted
-- ON CONFLICT (rebaseline_id, approver_id), but no unique index backed that
-- target (0006 created only a plain index), so Postgres rejects the upsert
-- (42P10) — sign-off could never succeed. A token now signs as its owner
-- (approver_id = the principal), which makes this index the DB guarantee that
-- a person holds exactly one vote however many identities they use. Fail-closed:
-- if duplicates exist the migration ABORTS (nothing is applied) instead of
-- skipping the index, because a missing index leaves every sign-off failing
-- 42P10 while the runner reports success. Remove the duplicates first with
-- CUTOVER/sql/lark-wave/dedupe-signoffs.sql, then re-run the migration.
do $$
begin
  if exists (
    select 1 from rebaseline_signoffs
    group by rebaseline_id, approver_id having count(*) > 1
  ) then
    raise exception '0045: duplicate rebaseline_signoffs (rebaseline_id, approver_id) rows exist, so the unique index cannot be created. Review and remove them with CUTOVER/sql/lark-wave/dedupe-signoffs.sql, then re-run the migration.'
      using hint = 'Nothing was applied; this file is rolled back as a whole.';
  end if;
end $$;

create unique index if not exists uniq_rebaseline_signoff_approver
  on rebaseline_signoffs (rebaseline_id, approver_id);

-- Report (never fail on) history that predates the rule.
do $$
declare
  n_del int;
  n_cr  int;
  n_ts  int;
begin
  select count(*) into n_del from deletion_requests
    where approved_principal_id is not null and approved_principal_id = requested_principal_id;
  select count(*) into n_cr from change_requests
    where decided_principal_id is not null and decided_principal_id = requested_principal_id;
  select count(*) into n_ts from timesheet_submissions
    where decided_principal_id is not null and decided_principal_id = submitted_principal_id;
  raise notice '0045: % deletion request(s), % change request(s), % timesheet(s) were decided by the same human who raised them (kept as history; blocked from now on)',
    n_del, n_cr, n_ts;
end $$;

-- ── 4. deletion commit RPCs: principal-aware, old overloads dropped ───────

-- The 0044 signatures (7 args) and, defensively, the pre-provenance 5-arg ones.
drop function if exists nopm_commit_task_deletion(uuid, uuid, text, uuid, text, text, text);
drop function if exists nopm_commit_task_deletion(uuid, uuid, text, uuid, text);

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
    delete from tasks where id = r.target_id and workspace_id = p_workspace_id;
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

-- ── 5. rebaseline sign-off trigger: compare principals too ────────────────
-- 0022 compared approver_id to rebaselines.requested_by, which is user-only
-- (NULL for a token-raised rebaseline) — so a token requester was never
-- compared at all. Now the HUMAN on each side is compared, and the legacy
-- profile check is kept for rows that predate the principal columns.

create or replace function nopm_rebaseline_no_self_signoff()
  returns trigger
  language plpgsql
  set search_path = public
as $$
declare
  req_user      uuid;
  req_principal uuid;
begin
  select requested_by, requested_principal_id into req_user, req_principal
    from rebaselines where id = new.rebaseline_id;

  if (req_user is not null and new.approver_id = req_user)
     or (req_principal is not null
         and coalesce(new.approver_principal_id, new.approver_id) = req_principal) then
    raise exception 'SELF_SIGNOFF: a rebaseline requester cannot sign off their own rebaseline'
      using errcode = 'P0003';
  end if;
  return new;
end;
$$;

-- The trigger itself (0022) already points at this function name; recreate it
-- idempotently so a fresh database and an upgraded one end in the same state.
drop trigger if exists trg_rebaseline_no_self_signoff on rebaseline_signoffs;
create trigger trg_rebaseline_no_self_signoff
  before insert or update on rebaseline_signoffs
  for each row execute function nopm_rebaseline_no_self_signoff();

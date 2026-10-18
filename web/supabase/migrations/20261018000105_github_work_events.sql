-- NoPM · 0105 github_work_events — task status pulled from work events (R-153; audit item A1).
-- A GitHub pull request opened / merged / closed or a deployment succeeding or failing moves the
-- task whose external_ref names it, instead of someone typing the status by hand.
--
-- Rides the Integration Hub (0046): the GitHub webhook is one more connector kind. Its secret is
-- AES-256-GCM ciphertext in integration_connectors.secret_enc (an HMAC verifier needs the raw key,
-- so it cannot be a hash). Every event is recorded in work_events (replay-protected by the
-- delivery id) whether or not it changed a task; a change to a task is an ordinary task.update
-- audit row written as a connector actor with provenance (0046 columns).
-- Additive only: no backfill, no existing row changes except the workspaces default.

-- ── connector kind: 'github' joins 'lark' ──────────────────────────────────
alter table integration_connectors drop constraint if exists integration_connectors_kind_check;
alter table integration_connectors
  add constraint integration_connectors_kind_check check (kind in ('lark', 'github'));

-- ── audit channel: 'github' joins the accepted channels (server-derived only, as 'lark') ──
alter table audit_log drop constraint audit_channel_check;
alter table audit_log
  add constraint audit_channel_check
  check (channel is null or channel in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark', 'github'))
  not valid;
alter table audit_log validate constraint audit_channel_check;

-- ── lookup: tasks by the external reference a work event carries ───────────
-- (0041 already enforces one task per (workspace, source, external_ref); this serves the
-- source-less lookup the webhook does.)
create index if not exists tasks_workspace_external_ref_idx
  on tasks (workspace_id, external_ref)
  where external_ref is not null;

-- ── workspaces.work_event_rules: which status each work event moves a task to ──
-- Keys are event kinds; a value is a status the task may be moved to, or JSON null for
-- "this event never moves a task". 'in_review' means status_type started with the label
-- "In review" (task status_type has no review state).
create or replace function nopm_valid_work_event_rules(r jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when r is null or jsonb_typeof(r) <> 'object' then false
    else
      not exists (
        select 1 from jsonb_object_keys(r) k
        where k not in ('pr_opened', 'pr_merged', 'pr_closed', 'deploy_success', 'deploy_failure')
      )
      and not exists (
        select 1 from jsonb_each(r) e
        where jsonb_typeof(e.value) <> 'null'
          and not (
            jsonb_typeof(e.value) = 'string'
            and (e.value #>> '{}') in ('unstarted', 'started', 'in_review', 'completed', 'canceled')
          )
      )
  end
$$;

alter table workspaces
  add column if not exists work_event_rules jsonb not null
    default '{"pr_opened": "started", "pr_merged": "in_review", "pr_closed": null, "deploy_success": "completed", "deploy_failure": null}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_work_event_rules_check') then
    alter table workspaces add constraint workspaces_work_event_rules_check
      check (nopm_valid_work_event_rules(work_event_rules));
  end if;
end $$;

comment on column workspaces.work_event_rules is
  'Event kind -> status a linked task moves to (unstarted, started, in_review, completed, canceled) or null for no move; validated by nopm_valid_work_event_rules.';

-- ── work_events (the ledger of received GitHub events) ─────────────────────
-- One row per (delivery, reference): a deployment can name several pull requests. The unique key is the
-- replay protection: a redelivery of the same X-GitHub-Delivery finds its rows and does nothing.
-- Bookkeeping, not governed data: the governed record of a task change is its audit_log row.
create table if not exists work_events (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  connector_id      uuid not null references integration_connectors(id) on delete cascade,
  provider          text not null default 'github' check (provider in ('github')),
  external_event_id text not null,
  kind              text not null check (kind in ('pr_opened', 'pr_merged', 'pr_closed', 'deploy_success', 'deploy_failure')),
  repo              text not null,
  ref               text not null,            -- owner/repo#123, or owner/repo when no pull request is named
  actor_login       text,
  -- sha-256 of the raw request body: the delivery id is a header the signature does not cover, so a
  -- captured signed body resent under a fresh id is caught by this (refused for 24 hours, reason 'replay').
  body_hash         text,
  task_id           uuid references tasks(id) on delete set null,
  received_at       timestamptz not null default now(),
  applied           boolean not null default false,
  applied_status    text,
  reason            text not null default 'received' check (reason in (
    'received', 'applied', 'project_locked', 'unknown_ref', 'no_rule',
    'already_at_or_beyond', 'task_canceled', 'conflict', 'no_linked_pr', 'replay', 'truncated', 'error'
  )),
  unique (connector_id, external_event_id, ref)
);
create index if not exists work_events_workspace_received_idx on work_events (workspace_id, received_at desc);
create index if not exists work_events_body_hash_idx on work_events (connector_id, body_hash, received_at desc) where body_hash is not null;
create index if not exists work_events_task_idx on work_events (task_id) where task_id is not null;

-- RLS select-only like the other server-written tables (0048 style): the service-role webhook
-- writes; a signed-in member reads only their own workspace.
alter table work_events enable row level security;
revoke insert, update, delete on work_events from anon, authenticated;
drop policy if exists "read work_events" on work_events;
create policy "read work_events" on work_events
  for select using (workspace_id = nopm_current_workspace());

-- ── nopm_apply_task_status_from_event: the status move, the lock check and the audit row in ONE transaction ──
-- A GitHub event may move a task only while its project is NOT locked. The application checks first, but a
-- lock taken between that read and the write would be missed (the lock triggers guard schedule fields, not
-- status). So the check is repeated here under a row lock: the task row is locked FOR UPDATE and the project
-- row FOR SHARE (taking a lock needs the project row exclusively, so it waits for this transaction). The move
-- and its single task.update audit row commit together or not at all; a locked project writes one
-- work_event.skipped audit row instead and changes nothing.
-- p_audit / p_skip_audit carry the actor fields exactly as nopm_mutate_audited's p_audit does (channel github).
-- Result: {result: applied|project_locked|conflict|not_found, after?}.
-- ORDER OF APPLY: with the rest of 0105, before the build. ROLLBACK: drop function nopm_apply_task_status_from_event(uuid, uuid, timestamptz, text, boolean, text, jsonb, jsonb);
create or replace function nopm_apply_task_status_from_event(
  p_workspace_id        uuid,
  p_task_id             uuid,
  p_expected_updated_at timestamptz,
  p_status_type         text,
  p_set_label           boolean,
  p_status_label        text,
  p_audit               jsonb,
  p_skip_audit          jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before tasks%rowtype;
  v_after  tasks%rowtype;
  v_locked boolean;
  v_audit  jsonb;
begin
  if p_status_type is null or p_status_type not in ('backlog', 'unstarted', 'started', 'completed', 'canceled') then
    raise exception 'INVALID_STATUS' using errcode = 'P0026';
  end if;
  if coalesce(p_audit ->> 'channel', '') <> 'github' or coalesce(p_skip_audit ->> 'channel', '') <> 'github' then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;

  select * into v_before from tasks where id = p_task_id and workspace_id = p_workspace_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select is_locked into v_locked from projects
   where id = v_before.project_id and workspace_id = p_workspace_id for share;

  if coalesce(v_locked, false) then
    v_audit := p_skip_audit;
    insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id,
                           before, after, channel, request_id, principal_id,
                           via_connector_id, external_event_id, external_actor_ref)
      values (p_workspace_id, (v_audit ->> 'actor_type')::actor_type, (v_audit ->> 'actor_id')::uuid,
              v_audit ->> 'actor_label', 'work_event.skipped', 'task', p_task_id,
              null,
              coalesce(v_audit -> 'after', '{}'::jsonb) || jsonb_build_object('reason', 'project_locked', 'project_id', v_before.project_id),
              'github', nullif(v_audit ->> 'request_id', ''), null,
              nullif(v_audit ->> 'via_connector_id', '')::uuid,
              nullif(v_audit ->> 'external_event_id', ''),
              nullif(v_audit ->> 'external_actor_ref', ''));
    return jsonb_build_object('result', 'project_locked');
  end if;

  if p_expected_updated_at is not null and v_before.updated_at is distinct from p_expected_updated_at then
    return jsonb_build_object('result', 'conflict');
  end if;

  update tasks
     set status_type = p_status_type::task_status_type,
         -- tasks.status is NOT NULL: a null label means "keep the current one", never "clear it"
         status      = case when p_set_label and p_status_label is not null then p_status_label else status end,
         updated_at  = now()
   where id = p_task_id and workspace_id = p_workspace_id
   returning * into v_after;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id,
                         before, after, channel, request_id, principal_id,
                         via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id, (p_audit ->> 'actor_type')::actor_type, (p_audit ->> 'actor_id')::uuid,
            p_audit ->> 'actor_label', 'task.update', 'task', p_task_id,
            to_jsonb(v_before), to_jsonb(v_after),
            'github', nullif(p_audit ->> 'request_id', ''), null,
            nullif(p_audit ->> 'via_connector_id', '')::uuid,
            nullif(p_audit ->> 'external_event_id', ''),
            nullif(p_audit ->> 'external_actor_ref', ''));

  return jsonb_build_object('result', 'applied', 'after', to_jsonb(v_after));
end;
$$;

revoke execute on function nopm_apply_task_status_from_event(uuid, uuid, timestamptz, text, boolean, text, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function nopm_apply_task_status_from_event(uuid, uuid, timestamptz, text, boolean, text, jsonb, jsonb) to service_role;

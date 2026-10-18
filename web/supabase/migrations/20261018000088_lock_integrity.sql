-- NoPM · 0088 lock_integrity (2026-10-18, audit gaps M7 + K3, owner answer Q-GOV-10).
--
-- THE GAP. A locked project is the frozen plan every sign-off hangs from, yet
-- nothing in the schema said a lock had to record who made it. nopm_lock_project
-- (0063 / 0072 / 0076) stored locked_by = NULL whenever the actor was a token or
-- a connector, because projects.locked_by is a profile FK and a token is not a
-- profile. There was no CHECK either, so is_locked = true with no locker and no
-- time was a legal row. The locker was recoverable only from the audit trail.
--
-- THE FIX.
--   1. Additive columns: locked_by_actor_type ('user' | 'token'),
--      locked_by_actor_id and locked_by_label. They name the ACTOR that locked,
--      whatever kind it is. locked_by (the profile FK) stays and now holds the
--      HUMAN: the user for a person, the token's creator (api_tokens.created_by)
--      for a token. It can still be NULL for a legacy token with no creator, which
--      is why the CHECK keys on the actor columns, not on locked_by.
--   2. CHECK projects_lock_integrity: is_locked = false OR (locked_at IS NOT NULL
--      AND locked_by_actor_id IS NOT NULL). Added NOT VALID first, so it bites on
--      every new write immediately, then validated after the backfill.
--   3. Backfill every already-locked row from its latest project.lock audit row
--      (actor_type / actor_id / actor_label / principal_id). A locked row with no
--      audit row at all is stamped with the nil system actor id and the label
--      'legacy lock (locker not recorded)', and counted in a RAISE NOTICE, so the
--      CHECK can be validated without inventing a person.
--   4. nopm_lock_project is recreated (same signature, so no old overload is left
--      callable; a guard drops any other overload) and sets all of the above.
--   5. A BEFORE UPDATE trigger clears the three actor columns when a project is
--      unlocked, so unlock (whichever RPC performs it) leaves no stale locker.
--
-- Permissions (Q-GOV-10) are unchanged and live in the API layer
-- (lib/governance/lock-permissions.ts): lock = manager, admin or a write token;
-- unlock = a manager or admin in person, never a token.
--
-- Idempotent and additive. ROLLBACK: alter table projects drop constraint
-- projects_lock_integrity; drop trigger trg_projects_lock_actor_clear on projects;
-- drop function nopm_projects_lock_actor_clear(); drop the three columns; re-apply
-- the 0076 body of nopm_lock_project.

alter table projects
  add column if not exists locked_by_actor_type text,
  add column if not exists locked_by_actor_id   uuid,
  add column if not exists locked_by_label      text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_locked_by_actor_type_check') then
    alter table projects
      add constraint projects_locked_by_actor_type_check
      check (locked_by_actor_type is null or locked_by_actor_type in ('user', 'token'));
  end if;
end $$;

comment on column projects.locked_by is
  'the HUMAN behind the lock (profiles.id): the user for a person, api_tokens.created_by for a token. NULL only for a legacy token with no recorded creator; locked_by_actor_id is the always-set evidence.';
comment on column projects.locked_by_actor_type is 'kind of the actor that locked the project: user | token. NULL while unlocked.';
comment on column projects.locked_by_actor_id   is 'id of the actor that locked the project (profile id or api_tokens id). No FK on purpose: evidence that must survive a profile or token being deleted. NULL while unlocked.';
comment on column projects.locked_by_label      is 'display label of the locker at lock time (a name, or "agent-name (token)"). NULL while unlocked.';

-- Unlock clears the actor columns whichever function performs the unlock.
create or replace function nopm_projects_lock_actor_clear()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_locked is not true then
    new.locked_by_actor_type := null;
    new.locked_by_actor_id   := null;
    new.locked_by_label      := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_projects_lock_actor_clear on projects;
create trigger trg_projects_lock_actor_clear
  before update on projects
  for each row execute function nopm_projects_lock_actor_clear();

-- The integrity CHECK: NOT VALID first (enforced for new writes at once).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_lock_integrity') then
    alter table projects
      add constraint projects_lock_integrity check (
        is_locked = false
        or (locked_at is not null and locked_by_actor_id is not null)
      ) not valid;
  end if;
end $$;

-- Backfill from the latest project.lock audit row per project. The updated_at
-- trigger is paused so no row is falsely stamped "modified now".
alter table projects disable trigger trg_projects_updated;

do $$
declare
  v_locked   integer;
  v_audit    integer;
  v_legacy   integer;
begin
  select count(*) into v_locked from projects
    where is_locked = true and (locked_at is null or locked_by_actor_id is null);

  with latest as (
    select distinct on (a.target_id)
           a.target_id, a.actor_type::text as actor_type, a.actor_id, a.actor_label,
           a.principal_id, a.created_at
      from audit_log a
     where a.target_type = 'project' and a.action = 'project.lock'
     order by a.target_id, a.created_at desc
  )
  update projects p
     set locked_at            = coalesce(p.locked_at, l.created_at),
         locked_by_actor_type = l.actor_type,
         locked_by_actor_id   = coalesce(l.actor_id, p.locked_by, '00000000-0000-0000-0000-000000000000'::uuid),
         locked_by_label      = coalesce(nullif(btrim(l.actor_label), ''), 'legacy lock (locker not recorded)'),
         locked_by            = coalesce(
                                  p.locked_by,
                                  (select pr.id from profiles pr where pr.id = l.principal_id))
    from latest l
   where l.target_id = p.id
     and p.is_locked = true
     and (p.locked_at is null or p.locked_by_actor_id is null);
  get diagnostics v_audit = row_count;

  -- No audit row at all: stamp the nil system actor (never invent a person).
  update projects p
     set locked_at            = coalesce(p.locked_at, p.updated_at, now()),
         locked_by_actor_type = case when p.locked_by is not null then 'user' else 'token' end,
         locked_by_actor_id   = coalesce(p.locked_by, '00000000-0000-0000-0000-000000000000'::uuid),
         locked_by_label      = 'legacy lock (locker not recorded)'
   where p.is_locked = true
     and (p.locked_at is null or p.locked_by_actor_id is null);
  get diagnostics v_legacy = row_count;

  raise notice '0088 lock_integrity: % locked project(s) needed a backfill; % taken from the audit trail, % stamped as legacy (no audit row).',
    v_locked, v_audit, v_legacy;
end $$;

alter table projects enable trigger trg_projects_updated;

-- Validate. Never blocks a release: if a row still violates the CHECK, say so
-- and leave it NOT VALID (it still guards every new write).
do $$
begin
  alter table projects validate constraint projects_lock_integrity;
exception when others then
  raise notice '0088: projects_lock_integrity left NOT VALID (%). It still guards new writes.', sqlerrm;
end $$;

-- No bypass signature: drop every nopm_lock_project overload except the one
-- recreated below.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'nopm_lock_project'
       and pg_get_function_identity_arguments(p.oid) <>
           'p_project_id uuid, p_workspace_id uuid, p_reason text, p_actor_type text, p_actor_id uuid, p_actor_label text, p_channel text, p_correlation_id text, p_via_connector_id uuid, p_external_event_id text, p_external_actor_ref text'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

-- == nopm_lock_project (from 20261017000076) ==

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
  v_principal uuid;
  v_label     text;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;

  -- 0088 (M7 / K3): who is locking. A user is their own principal; a token's
  -- principal is the human who minted it (api_tokens.created_by, NULL for a
  -- legacy token with no recorded creator). The actor columns are ALWAYS set.
  v_principal := nopm_audit_principal(p_workspace_id, p_actor_type, p_actor_id);
  v_label := coalesce(nullif(btrim(p_actor_label), ''), p_actor_type || ' ' || p_actor_id::text);

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
         locked_by = case when p_actor_type = 'user' then p_actor_id else v_principal end,
         locked_by_actor_type = p_actor_type,
         locked_by_actor_id   = p_actor_id,
         locked_by_label      = v_label,
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

-- NoPM · 0083 (2026-10-17) — people & roles: role change, removal, restore, two-step reset.
--
-- WHY. Changing a role, removing a leaver and resetting a lost authenticator were
-- operator jobs (docs/runbooks/user-provisioning.md). The profile cannot be
-- deleted (31 foreign keys point at profiles), so a person is "removed" by a
-- status on the profile; their history stays intact.
--
-- WHAT.
--  * profiles.status ('active' | 'removed'), removed_at, removed_by, removed_prev_role.
--  * nopm_member_change(): set_role / remove / restore in ONE transaction with the
--    audit row. Locks the active admins so the LAST admin can never be demoted or
--    removed (race-safe). Remove also revokes the person's API tokens and cancels
--    the pending invites they sent. Restore reactivates the same profile.
--  * nopm_member_mfa_reset(): an admin clears a member's authenticator and issues
--    one-time backup codes (hashes passed in, shown once by the app); audited and
--    the member gets an in-app notification, all in one transaction.
-- Additive and idempotent. Rollback: drop the two functions; drop the four columns.

alter table profiles add column if not exists status text not null default 'active';
alter table profiles add column if not exists removed_at timestamptz;
alter table profiles add column if not exists removed_by uuid references profiles(id);
alter table profiles add column if not exists removed_prev_role member_role;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_status_check') then
    alter table profiles add constraint profiles_status_check check (status in ('active', 'removed')) not valid;
  end if;
end $$;

create index if not exists profiles_workspace_status_idx on profiles(workspace_id, status);

create or replace function nopm_member_change(
  p_workspace_id   uuid,
  p_target_id      uuid,
  p_action         text,
  p_new_role       member_role default null,
  p_actor_id       uuid default null,
  p_actor_label    text default null,
  p_channel        text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor     profiles%rowtype;
  v_target    profiles%rowtype;
  v_after     profiles%rowtype;
  v_admins    int;
  v_tokens    jsonb := '[]'::jsonb;
  v_invites   jsonb := '[]'::jsonb;
  v_role      member_role;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if p_action not in ('set_role', 'remove', 'restore') then
    raise exception 'INVALID_ACTION' using errcode = 'P0005';
  end if;
  if p_actor_id is null then
    raise exception 'NO_PRINCIPAL' using errcode = 'P0006';
  end if;

  -- Lock every active admin (stable order) so two concurrent demotions cannot both pass the last-admin check.
  perform 1 from profiles where workspace_id = p_workspace_id and role = 'admin' and status = 'active' order by id for update;
  select count(*) into v_admins from profiles where workspace_id = p_workspace_id and role = 'admin' and status = 'active';

  select * into v_actor from profiles where id = p_actor_id and workspace_id = p_workspace_id;
  if not found or v_actor.status <> 'active' then
    raise exception 'ROLE_NOT_PERMITTED: not an active member' using errcode = 'P0018';
  end if;

  select * into v_target from profiles where id = p_target_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Leaving is open to everyone; everything else is admin-only.
  if not (p_action = 'remove' and p_actor_id = p_target_id) and v_actor.role <> 'admin' then
    raise exception 'ROLE_NOT_PERMITTED: only an admin can do this' using errcode = 'P0018';
  end if;

  if p_action = 'set_role' then
    if p_new_role is null then raise exception 'INVALID_ROLE' using errcode = 'P0005'; end if;
    if v_target.status <> 'active' then raise exception 'REMOVED' using errcode = 'P0011'; end if;
    if v_target.role = p_new_role then raise exception 'NO_CHANGE' using errcode = 'P0007'; end if;
    if v_target.role = 'admin' and p_new_role <> 'admin' and v_admins <= 1 then
      raise exception 'LAST_ADMIN' using errcode = 'P0010';
    end if;
    update profiles set role = p_new_role where id = p_target_id returning * into v_after;

  elsif p_action = 'remove' then
    if v_target.status <> 'active' then raise exception 'REMOVED' using errcode = 'P0011'; end if;
    if v_target.role = 'admin' and v_admins <= 1 then
      raise exception 'LAST_ADMIN' using errcode = 'P0010';
    end if;
    update profiles
       set status = 'removed', removed_at = now(), removed_by = p_actor_id,
           removed_prev_role = v_target.role, role = 'viewer'
     where id = p_target_id returning * into v_after;

    with t as (
      update api_tokens set revoked = true
       where workspace_id = p_workspace_id and created_by = p_target_id and revoked = false
       returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_tokens from t;

    with i as (
      update invites set revoked = true
       where workspace_id = p_workspace_id and created_by = p_target_id
         and revoked = false and accepted_at is null and expires_at > now()
       returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_invites from i;

  else
    if v_target.status <> 'removed' then raise exception 'NOT_REMOVED' using errcode = 'P0012'; end if;
    v_role := coalesce(p_new_role, v_target.removed_prev_role, 'member');
    update profiles
       set status = 'active', removed_at = null, removed_by = null, removed_prev_role = null, role = v_role
     where id = p_target_id returning * into v_after;
  end if;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, principal_id)
    values (p_workspace_id, 'user'::actor_type, p_actor_id, p_actor_label,
            case p_action when 'set_role' then 'member.role_change' when 'remove' then 'member.remove' else 'member.restore' end,
            'profile', p_target_id,
            jsonb_build_object('role', v_target.role, 'status', v_target.status),
            jsonb_build_object('role', v_after.role, 'status', v_after.status)
              || case when p_action = 'remove'
                      then jsonb_build_object('previous_role', v_target.role, 'self', p_actor_id = p_target_id,
                                              'revoked_tokens', v_tokens, 'cancelled_invites', v_invites)
                      else '{}'::jsonb end,
            p_channel, p_correlation_id, p_actor_id);

  return jsonb_build_object('member', to_jsonb(v_after), 'revoked_tokens', v_tokens, 'cancelled_invites', v_invites);
end;
$$;

revoke execute on function nopm_member_change(uuid, uuid, text, member_role, uuid, text, text, text) from public, anon, authenticated;
grant  execute on function nopm_member_change(uuid, uuid, text, member_role, uuid, text, text, text) to service_role;

create or replace function nopm_member_mfa_reset(
  p_workspace_id   uuid,
  p_target_id      uuid,
  p_secret_enc     text,
  p_backup_hashes  text[],
  p_actor_id       uuid default null,
  p_actor_label    text default null,
  p_channel        text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  profiles%rowtype;
  v_target profiles%rowtype;
  v_old    user_mfa%rowtype;
begin
  if p_channel is not null and p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if p_actor_id is null then raise exception 'NO_PRINCIPAL' using errcode = 'P0006'; end if;
  if coalesce(array_length(p_backup_hashes, 1), 0) = 0 or coalesce(p_secret_enc, '') = '' then
    raise exception 'INVALID_INPUT' using errcode = 'P0005';
  end if;

  select * into v_actor from profiles where id = p_actor_id and workspace_id = p_workspace_id and status = 'active';
  if not found or v_actor.role <> 'admin' then
    raise exception 'ROLE_NOT_PERMITTED: only an admin can reset two-step' using errcode = 'P0018';
  end if;
  if p_actor_id = p_target_id then
    raise exception 'SELF_RESET' using errcode = 'P0013';
  end if;
  select * into v_target from profiles where id = p_target_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_target.status <> 'active' then raise exception 'REMOVED' using errcode = 'P0011'; end if;

  select * into v_old from user_mfa where user_id = p_target_id for update;

  -- The new secret is random and known to nobody: only the one-time backup codes can sign in.
  insert into user_mfa (user_id, totp_secret, enabled, backup_codes, enrolled_at, confirmed_at, last_totp_step)
    values (p_target_id, p_secret_enc, true, p_backup_hashes, now(), now(), null)
  on conflict (user_id) do update
     set totp_secret = excluded.totp_secret, enabled = true, backup_codes = excluded.backup_codes,
         enrolled_at = now(), confirmed_at = now(), last_totp_step = null;

  insert into notifications (workspace_id, recipient_id, type, title, body, payload)
    values (p_workspace_id, p_target_id, 'member.mfa_reset', 'Your two-step sign-in was reset',
            'A workspace admin reset your two-step sign-in. Use one of the backup codes they gave you to sign in, then set up your authenticator again in Settings.',
            jsonb_build_object('href', '/settings'));

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id, principal_id)
    values (p_workspace_id, 'user'::actor_type, p_actor_id, p_actor_label,
            'member.mfa_reset', 'profile', p_target_id,
            jsonb_build_object('enabled', coalesce(v_old.enabled, false), 'backup_codes_left', coalesce(array_length(v_old.backup_codes, 1), 0)),
            jsonb_build_object('enabled', true, 'backup_codes_issued', array_length(p_backup_hashes, 1)),
            p_channel, p_correlation_id, p_actor_id);

  return jsonb_build_object('target_id', p_target_id, 'backup_codes_issued', array_length(p_backup_hashes, 1));
end;
$$;

revoke execute on function nopm_member_mfa_reset(uuid, uuid, text, text[], uuid, text, text, text) from public, anon, authenticated;
grant  execute on function nopm_member_mfa_reset(uuid, uuid, text, text[], uuid, text, text, text) to service_role;

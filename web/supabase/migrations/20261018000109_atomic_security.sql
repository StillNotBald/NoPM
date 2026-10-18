-- NoPM · 0109 (2026-10-18) — security and integration writes are ONE transaction with their audit row (M1 close-out, W5-B, R-163 and R-164).
--
-- WHY. Twelve handlers still wrote the change first and the audit row second (atomicity.test.ts list): the four
-- two-step sign-in transitions, the Lark connector create and update, the GitHub connector create, update and
-- revoke, the assistant token, the invite sweep and the identity link. A failure between the two left a change
-- the trail never saw. Each now calls ONE function below; the function does the change and writes its audit row
-- through the shared helper nopm_audit_insert (0107) inside the same transaction. The assistant token needs no
-- function: it uses the generic nopm_mutate_audited (0103) on api_tokens.
--
-- WHAT (all security definer, search_path pinned to public, service role only, workspace-filtered):
--   nopm_mfa_enroll(ws, user, secret_enc, reset_step, audit)                     user_mfa upsert + mfa.enroll_started
--   nopm_mfa_challenge(ws, user, outcome, backup_hash, audit)                    backup-code burn (compare-and-set) + challenge_passed / challenge_failed
--   nopm_mfa_verify(ws, user, outcome, backup_hashes, audit)                     enable + backup code hashes + mfa.enabled, or verify_failed
--   nopm_mfa_disable(ws, user, mode, reset_step, audit)                          clear the factor + mfa.disabled, or disable_failed
--   nopm_connector_write(ws, op, id, patch, ...)                                 Lark connector create / update + the MASKED public view in the audit row
--   nopm_github_connector_write(ws, op, id, ...)                                 GitHub connector create / update / revoke; update also writes workspaces.work_event_rules with its own audit row
--   nopm_revoke_other_invites(ws, email, keep_invite, audit)                     bulk revoke by e-mail, one invite.revoked row per invite
--   nopm_link_identity(ws, connector, code_hash, profile, tenant, user, ...)     consume link code + revoke previous + insert identity + tenant pin + audit
--   nopm_mask_external_id(text), nopm_lark_connector_audit_view(row, jsonb)      pure helpers (the masking of store.ts, once, in SQL)
--
-- WHAT STAYS OUTSIDE ON PURPOSE (R-163c). The failed-guess counter (nopm_rate_check, spendMfaAttempt) and the TOTP
-- step burn (consumeTotp, user_mfa.last_totp_step) are separate calls made BEFORE these functions. They must keep
-- counting when an audit write fails, so a failing audit can never grant a free guess. TOTP verification itself
-- (decrypt, otplib) stays in the app; the functions record the outcome.
--
-- SECRETS. totp_secret, backup codes (only SHA-256 hashes ever reach SQL), connector secret_enc and relay hash are
-- written but never put into an audit row and never raised in an error message. The connector audit view carries
-- presence flags only.
--
-- ERROR CODES (message = code, like 0069 and 0103): NOT_FOUND (P0002), CONNECTOR_NOT_FOUND (P0002),
-- CONNECTOR_REVOKED (P0001), INVALID_OP (P0085). A unique violation (23505, one live connector per kind) passes
-- through untouched so the routes keep mapping it to connector_exists.
--
-- BEHAVIOUR NOTE. user_mfa.backup_codes is NOT NULL (0002); the old routes wrote JSON null there. The functions
-- write the empty array, which every reader treats the same as null.
--
-- ORDER OF APPLY. After 0107 (nopm_audit_insert). Additive: creates functions only, touches no row and no table,
-- safe on the live data at ledger 0108 or lower. The old build does not call these functions, so deploy order is free.
-- Safe to re-run (create or replace).
--
-- ROLLBACK.
--   drop function if exists nopm_mfa_enroll(uuid, uuid, text, boolean, jsonb);
--   drop function if exists nopm_mfa_challenge(uuid, uuid, text, text, jsonb);
--   drop function if exists nopm_mfa_verify(uuid, uuid, text, text[], jsonb);
--   drop function if exists nopm_mfa_disable(uuid, uuid, text, boolean, jsonb);
--   drop function if exists nopm_connector_write(uuid, text, uuid, jsonb, uuid, jsonb, jsonb, jsonb, jsonb);
--   drop function if exists nopm_github_connector_write(uuid, text, uuid, text, text, text, boolean, uuid, jsonb, jsonb, jsonb);
--   drop function if exists nopm_revoke_other_invites(uuid, text, uuid, jsonb);
--   drop function if exists nopm_link_identity(uuid, uuid, text, uuid, text, text, text, text, jsonb);
--   drop function if exists nopm_lark_connector_audit_view(integration_connectors, jsonb);
--   drop function if exists nopm_mask_external_id(text);

-- ── pure helpers ───────────────────────────────────────────────────────────────

-- maskExternalId (store.ts): enough to recognise, not enough to reuse.
create or replace function nopm_mask_external_id(p_id text) returns text
language sql immutable
as $$
  select case
    when p_id is null then null
    when length(p_id) <= 10 then left(p_id, 2) || '…'
    else left(p_id, 6) || '…' || right(p_id, 4)
  end;
$$;

-- toAuditConnector(toPublicConnector(row)) of store.ts, minus the secret presence flags (those need the
-- decrypted blob, so the route computes them and passes p_secrets). Never contains secret_enc or the relay hash.
create or replace function nopm_lark_connector_audit_view(r integration_connectors, p_secrets jsonb) returns jsonb
language sql immutable
as $$
  select jsonb_build_object(
      'id', r.id,
      'kind', r.kind,
      'name', r.name,
      'status', r.status,
      'region', case when r.config ->> 'region' = 'feishu' then 'feishu' else 'lark' end,
      'app_id', case when jsonb_typeof(r.config -> 'appId') = 'string' then nopm_mask_external_id(r.config ->> 'appId') else '' end,
      'mode', case when r.config ->> 'mode' = 'long_connection' then 'long_connection' else 'webhook' end,
      'approvals', jsonb_build_object('enabled', coalesce((r.config -> 'approvals' -> 'enabled') <> 'false'::jsonb, true)),
      'digest', jsonb_build_object(
          'enabled', coalesce((r.config -> 'digest' -> 'enabled') = 'true'::jsonb, false),
          'chat_id', case when jsonb_typeof(r.config -> 'digest' -> 'chatId') = 'string' and (r.config -> 'digest' ->> 'chatId') <> ''
                          then to_jsonb(nopm_mask_external_id(r.config -> 'digest' ->> 'chatId')) else 'null'::jsonb end,
          'weekday', case when jsonb_typeof(r.config -> 'digest' -> 'weekday') = 'number'
                               and (r.config -> 'digest' ->> 'weekday')::numeric between 0 and 6
                          then r.config -> 'digest' -> 'weekday' else to_jsonb(1) end),
      'has_relay_secret', coalesce(r.relay_secret_hash <> '', false),
      'tenant_pinned', r.tenant_key is not null and r.tenant_key <> '',
      'created_by', r.created_by,
      'created_at', r.created_at,
      'updated_at', r.updated_at,
      'revoked_at', r.revoked_at
    ) || coalesce(p_secrets, '{}'::jsonb);
$$;

-- ── MFA (R-163) ────────────────────────────────────────────────────────────────

-- Start (or restart) enrolment: a fresh encrypted secret, factor off, no backup codes. p_reset_step false is the
-- fallback for a database without last_totp_step (the route retries with it when the column is missing).
create or replace function nopm_mfa_enroll(
  p_workspace_id uuid,
  p_user_id      uuid,
  p_secret_enc   text,
  p_reset_step   boolean default true,
  p_audit        jsonb   default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from profiles where id = p_user_id and workspace_id = p_workspace_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_secret_enc is null or p_secret_enc = '' then
    raise exception 'INVALID_OP: a secret is required' using errcode = 'P0085';
  end if;

  if coalesce(p_reset_step, true) then
    insert into user_mfa (user_id, totp_secret, enabled, backup_codes, confirmed_at, enrolled_at, last_totp_step)
      values (p_user_id, p_secret_enc, false, '{}', null, now(), null)
    on conflict (user_id) do update
      set totp_secret = excluded.totp_secret, enabled = false, backup_codes = '{}',
          confirmed_at = null, enrolled_at = excluded.enrolled_at, last_totp_step = null;
  else
    insert into user_mfa (user_id, totp_secret, enabled, backup_codes, confirmed_at, enrolled_at)
      values (p_user_id, p_secret_enc, false, '{}', null, now())
    on conflict (user_id) do update
      set totp_secret = excluded.totp_secret, enabled = false, backup_codes = '{}',
          confirmed_at = null, enrolled_at = excluded.enrolled_at;
  end if;

  perform nopm_audit_insert(p_workspace_id, p_audit, p_user_id, null, jsonb_build_object('enabled', false));
  return jsonb_build_object('enrolled', true);
end;
$$;

-- Record a sign-in challenge. p_outcome: 'totp' (the code was a valid, unused TOTP), 'backup_code' (the app found the
-- code's hash among the stored ones; this function burns it with a compare-and-set so two requests holding the same
-- code cannot both pass) or 'failed' (wrong code, replay). Returns {result: 'passed' | 'failed'}.
create or replace function nopm_mfa_challenge(
  p_workspace_id uuid,
  p_user_id      uuid,
  p_outcome      text,
  p_backup_hash  text  default null,
  p_audit        jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_burned int;
begin
  if not exists (select 1 from profiles where id = p_user_id and workspace_id = p_workspace_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_outcome is null or p_outcome not in ('totp', 'backup_code', 'failed') then
    raise exception 'INVALID_OP: outcome' using errcode = 'P0085';
  end if;

  if p_outcome = 'backup_code' then
    if p_backup_hash is null or p_backup_hash = '' then
      raise exception 'INVALID_OP: a backup code hash is required' using errcode = 'P0085';
    end if;
    update user_mfa
       set backup_codes = array_remove(backup_codes, p_backup_hash)
     where user_id = p_user_id and backup_codes @> array[p_backup_hash];
    get diagnostics v_burned = row_count;
    if v_burned = 0 then
      -- Already consumed by a concurrent request: treated as a wrong code.
      p_outcome := 'failed';
    end if;
  end if;

  if p_outcome = 'failed' then
    perform nopm_audit_insert(p_workspace_id, p_audit || jsonb_build_object('action', 'auth.mfa.challenge_failed'),
                              p_user_id, null, null);
    return jsonb_build_object('result', 'failed');
  end if;

  perform nopm_audit_insert(p_workspace_id, p_audit || jsonb_build_object('action', 'auth.mfa.challenge_passed'),
                            p_user_id, null,
                            jsonb_build_object('via', case when p_outcome = 'backup_code' then 'backup_code' else 'totp' end));
  return jsonb_build_object('result', 'passed');
end;
$$;

-- Confirm enrolment. p_outcome: 'ok' (the app checked the code and burned its step) enables the factor and stores
-- the backup code HASHES; 'invalid' / 'replay' only records auth.mfa.verify_failed.
create or replace function nopm_mfa_verify(
  p_workspace_id  uuid,
  p_user_id       uuid,
  p_outcome       text,
  p_backup_hashes text[] default null,
  p_audit         jsonb  default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was boolean;
begin
  if not exists (select 1 from profiles where id = p_user_id and workspace_id = p_workspace_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_outcome is null or p_outcome not in ('ok', 'invalid', 'replay') then
    raise exception 'INVALID_OP: outcome' using errcode = 'P0085';
  end if;

  if p_outcome <> 'ok' then
    perform nopm_audit_insert(p_workspace_id, p_audit || jsonb_build_object('action', 'auth.mfa.verify_failed'),
                              p_user_id, null, jsonb_build_object('reason', p_outcome));
    return jsonb_build_object('enabled', false);
  end if;

  select enabled into v_was from user_mfa where user_id = p_user_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  update user_mfa
     set enabled = true, backup_codes = coalesce(p_backup_hashes, '{}'), confirmed_at = now()
   where user_id = p_user_id;

  perform nopm_audit_insert(p_workspace_id, p_audit || jsonb_build_object('action', 'mfa.enabled'),
                            p_user_id, jsonb_build_object('enabled', v_was), jsonb_build_object('enabled', true));
  return jsonb_build_object('enabled', true);
end;
$$;

-- Turn the factor off. p_mode: 'recent_challenge', 'code' or 'cancel_enrollment' (the route decided the proof);
-- 'failed' only records auth.mfa.disable_failed. totp_secret is NOT NULL, so the wiped secret is the empty string.
create or replace function nopm_mfa_disable(
  p_workspace_id uuid,
  p_user_id      uuid,
  p_mode         text,
  p_reset_step   boolean default true,
  p_audit        jsonb   default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was boolean;
begin
  if not exists (select 1 from profiles where id = p_user_id and workspace_id = p_workspace_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_mode is null or p_mode not in ('recent_challenge', 'code', 'cancel_enrollment', 'failed') then
    raise exception 'INVALID_OP: mode' using errcode = 'P0085';
  end if;

  if p_mode = 'failed' then
    perform nopm_audit_insert(p_workspace_id, p_audit || jsonb_build_object('action', 'auth.mfa.disable_failed'),
                              p_user_id, null, null);
    return jsonb_build_object('enabled', null);
  end if;

  select enabled into v_was from user_mfa where user_id = p_user_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if coalesce(p_reset_step, true) then
    update user_mfa set enabled = false, totp_secret = '', backup_codes = '{}', last_totp_step = null
     where user_id = p_user_id;
  else
    update user_mfa set enabled = false, totp_secret = '', backup_codes = '{}'
     where user_id = p_user_id;
  end if;

  perform nopm_audit_insert(p_workspace_id, p_audit || jsonb_build_object('action', 'mfa.disabled'),
                            p_user_id, jsonb_build_object('enabled', v_was),
                            jsonb_build_object('enabled', false, 'via', p_mode));
  return jsonb_build_object('enabled', false);
end;
$$;

-- ── Lark connector (R-164a) ────────────────────────────────────────────────────

-- op 'create': insert (workspace from the argument, never the body). op 'update': apply p_patch (keys name, status,
-- config, secret_enc, relay_secret_hash, tenant_key; a missing key is left alone, tenant_key null clears the pin)
-- to a live (not revoked) Lark connector. The audit row carries the MASKED public view (built here) plus
-- p_secrets (presence flags computed by the route from the decrypted blob) plus p_extras (which secrets changed).
-- Returns the stored row (the route needs it; it never reaches an API response unfiltered).
create or replace function nopm_connector_write(
  p_workspace_id uuid,
  p_op           text,
  p_connector_id uuid  default null,
  p_patch        jsonb default '{}'::jsonb,
  p_created_by   uuid  default null,
  p_secrets      jsonb default '{}'::jsonb,
  p_before       jsonb default null,
  p_extras       jsonb default '{}'::jsonb,
  p_audit        jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row integration_connectors%rowtype;
  v_cur integration_connectors%rowtype;
begin
  if p_workspace_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_op is null or p_op not in ('create', 'update') then
    raise exception 'INVALID_OP' using errcode = 'P0085';
  end if;
  p_patch := coalesce(p_patch, '{}'::jsonb);

  if p_op = 'create' then
    insert into integration_connectors (workspace_id, kind, name, status, config, secret_enc, relay_secret_hash, created_by)
      values (p_workspace_id, 'lark', p_patch ->> 'name', 'active', coalesce(p_patch -> 'config', '{}'::jsonb),
              p_patch ->> 'secret_enc', p_patch ->> 'relay_secret_hash', p_created_by)
      returning * into v_row;   -- a second live connector raises 23505 (uniq_live_connector_per_kind), mapped by the route
    perform nopm_audit_insert(p_workspace_id, p_audit, v_row.id, null,
                              nopm_lark_connector_audit_view(v_row, p_secrets) || coalesce(p_extras, '{}'::jsonb));
    return to_jsonb(v_row);
  end if;

  select * into v_cur from integration_connectors
   where id = p_connector_id and workspace_id = p_workspace_id and kind = 'lark' for update;
  if not found then
    raise exception 'CONNECTOR_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_cur.status = 'revoked' then
    raise exception 'CONNECTOR_REVOKED' using errcode = 'P0001';
  end if;

  update integration_connectors c
     set name              = case when p_patch ? 'name' then p_patch ->> 'name' else c.name end,
         status            = case when p_patch ? 'status' then p_patch ->> 'status' else c.status end,
         config            = case when p_patch ? 'config' then p_patch -> 'config' else c.config end,
         secret_enc        = case when p_patch ? 'secret_enc' then p_patch ->> 'secret_enc' else c.secret_enc end,
         relay_secret_hash = case when p_patch ? 'relay_secret_hash' then p_patch ->> 'relay_secret_hash' else c.relay_secret_hash end,
         tenant_key        = case when p_patch ? 'tenant_key' then p_patch ->> 'tenant_key' else c.tenant_key end
   where c.id = p_connector_id and c.workspace_id = p_workspace_id and c.kind = 'lark'
   returning * into v_row;

  perform nopm_audit_insert(p_workspace_id, p_audit, v_row.id, p_before,
                            nopm_lark_connector_audit_view(v_row, p_secrets) || coalesce(p_extras, '{}'::jsonb));
  return to_jsonb(v_row);
end;
$$;

-- ── GitHub connector (R-164a) ──────────────────────────────────────────────────

-- op 'create' | 'update' | 'revoke'. Audit payloads are small and built here ({kind, name, status}); the webhook
-- secret column is written and never read into an audit row. 'update' changes the connector (when p_connector_id is
-- given: status and/or a rotated secret) and, when p_rules_after is given, workspaces.work_event_rules with its OWN
-- audit row (work_event_rules.update), all in one transaction. Returns {connector: row | null, rules_written}.
create or replace function nopm_github_connector_write(
  p_workspace_id   uuid,
  p_op             text,
  p_connector_id   uuid        default null,
  p_name           text        default null,
  p_status         text        default null,
  p_secret_enc     text        default null,
  p_secret_rotated boolean     default false,
  p_created_by     uuid        default null,
  p_rules_before   jsonb       default null,
  p_rules_after    jsonb       default null,
  p_audit          jsonb       default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row integration_connectors%rowtype;
  v_cur integration_connectors%rowtype;
  v_rules_written boolean := false;
begin
  if p_workspace_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_op is null or p_op not in ('create', 'update', 'revoke') then
    raise exception 'INVALID_OP' using errcode = 'P0085';
  end if;

  if p_op = 'create' then
    insert into integration_connectors (workspace_id, kind, name, status, config, secret_enc, created_by)
      values (p_workspace_id, 'github', p_name, 'active', '{}'::jsonb, p_secret_enc, p_created_by)
      returning * into v_row;   -- 23505 when a live GitHub connector exists; the route maps it
    perform nopm_audit_insert(p_workspace_id, p_audit, v_row.id, null,
                              jsonb_build_object('kind', 'github', 'name', v_row.name, 'status', v_row.status));
    return jsonb_build_object('connector', to_jsonb(v_row), 'rules_written', false);
  end if;

  if p_op = 'revoke' then
    select * into v_cur from integration_connectors
     where id = p_connector_id and workspace_id = p_workspace_id and kind = 'github' for update;
    if not found then
      raise exception 'CONNECTOR_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_cur.status = 'revoked' then
      raise exception 'CONNECTOR_REVOKED' using errcode = 'P0001';
    end if;
    update integration_connectors c set status = 'revoked', revoked_at = now()
     where c.id = p_connector_id and c.workspace_id = p_workspace_id and c.kind = 'github'
     returning * into v_row;
    perform nopm_audit_insert(p_workspace_id, p_audit, v_row.id,
                              jsonb_build_object('kind', 'github', 'status', v_cur.status),
                              jsonb_build_object('kind', 'github', 'status', 'revoked'));
    return jsonb_build_object('connector', to_jsonb(v_row), 'rules_written', false);
  end if;

  -- update
  if p_connector_id is not null then
    select * into v_cur from integration_connectors
     where id = p_connector_id and workspace_id = p_workspace_id and kind = 'github' for update;
    if not found or v_cur.status = 'revoked' then
      raise exception 'CONNECTOR_NOT_FOUND' using errcode = 'P0002';
    end if;
    update integration_connectors c
       set status     = coalesce(p_status, c.status),
           secret_enc = coalesce(p_secret_enc, c.secret_enc)
     where c.id = p_connector_id and c.workspace_id = p_workspace_id and c.kind = 'github'
     returning * into v_row;
    perform nopm_audit_insert(p_workspace_id, p_audit, v_row.id,
                              jsonb_build_object('kind', 'github', 'status', v_cur.status),
                              jsonb_build_object('kind', 'github', 'status', v_row.status,
                                                 'secret_rotated', coalesce(p_secret_rotated, false)));
  end if;

  if p_rules_after is not null then
    update workspaces set work_event_rules = p_rules_after where id = p_workspace_id;
    if not found then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    perform nopm_audit_insert(p_workspace_id,
                              p_audit || jsonb_build_object('action', 'work_event_rules.update', 'target_type', 'workspace'),
                              p_workspace_id, p_rules_before, p_rules_after);
    v_rules_written := true;
  end if;

  return jsonb_build_object('connector', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'rules_written', v_rules_written);
end;
$$;

-- ── invite sweep (R-164c) ──────────────────────────────────────────────────────

-- When an invite for an e-mail is accepted, every OTHER open invite for that e-mail in the workspace is revoked and
-- gets one invite.revoked row, in one transaction. Keeps the ilike escape (backslash, % and _ are literals),
-- accepted_at is null and revoked = false. Returns the revoked invite ids.
create or replace function nopm_revoke_other_invites(
  p_workspace_id   uuid,
  p_email          text,
  p_keep_invite_id uuid,
  p_audit          jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pattern text;
  v_ids     jsonb := '[]'::jsonb;
  r         record;
begin
  if p_workspace_id is null or p_email is null or p_email = '' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_pattern := replace(replace(replace(p_email, '\', '\\'), '%', '\%'), '_', '\_');

  for r in
    with revoked as (
      update invites i set revoked = true
       where i.workspace_id = p_workspace_id
         and i.email ilike v_pattern
         and i.id is distinct from p_keep_invite_id
         and i.revoked = false
         and i.accepted_at is null
       returning i.id, i.email, i.role::text as role
    )
    select * from revoked
  loop
    perform nopm_audit_insert(
      p_workspace_id, p_audit, r.id,
      jsonb_build_object('email', r.email, 'role', r.role, 'revoked', false),
      jsonb_build_object('email', r.email, 'role', r.role, 'revoked', true,
                         'reason', 'another invite for this email was accepted'));
    v_ids := v_ids || to_jsonb(r.id);
  end loop;

  return v_ids;
end;
$$;

-- ── identity link (R-164d) ─────────────────────────────────────────────────────

-- Consume a link code and create the identity link, all in ONE transaction: the code row and the connector row are
-- locked, then (tenant pin for an admin or manager's first link) code burned, previous link of the profile revoked,
-- identity inserted, audit written. If any step fails nothing is kept, so a consumed code with no identity cannot
-- exist and there is no compensating code. Returns {status, ...}:
--   linked (already_linked, profile_label, displaced[]) | already_used | expired | invalid_code | paused |
--   forbidden (reason tenant_mismatch) | conflict (reason account_taken | already_linked | duplicate)
-- A refused replacement (the profile already holds a link) burns the code and records
-- integration.identity.link.blocked in a sub-transaction, best effort like before: if that write fails the code stays usable.
create or replace function nopm_link_identity(
  p_workspace_id      uuid,
  p_connector_id      uuid,
  p_code_hash         text,
  p_profile_id        uuid,
  p_external_tenant   text,
  p_external_user_id  text,
  p_external_union_id text  default null,
  p_display_name      text  default null,
  p_audit             jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn     integration_connectors%rowtype;
  v_code     identity_link_codes%rowtype;
  v_prof     record;
  v_same     record;
  v_held     record;
  v_label    text;
  v_pinned   boolean := false;
  v_new      uuid;
  v_replaced jsonb   := '[]'::jsonb;
  v_ref      text;
begin
  select * into v_conn from integration_connectors
   where id = p_connector_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'CONNECTOR_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_conn.status <> 'active' then
    return jsonb_build_object('status', 'paused');
  end if;
  if v_conn.tenant_key is not null and v_conn.tenant_key <> p_external_tenant then
    return jsonb_build_object('status', 'forbidden', 'reason', 'tenant_mismatch');
  end if;

  select * into v_code from identity_link_codes
   where code_hash = p_code_hash and workspace_id = p_workspace_id and connector_id = p_connector_id for update;
  if not found or v_code.profile_id is distinct from p_profile_id then
    return jsonb_build_object('status', 'invalid_code');
  end if;
  if v_code.used_at is not null then
    return jsonb_build_object('status', 'already_used');
  end if;
  if v_code.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  select id, role::text as role, display_name, email into v_prof
    from profiles where id = v_code.profile_id and workspace_id = p_workspace_id;
  if not found then
    return jsonb_build_object('status', 'invalid_code');
  end if;
  v_label := coalesce(nullif(v_prof.display_name, ''), nullif(v_prof.email, ''), v_prof.id::text);
  v_ref := v_conn.kind || ':' || nopm_mask_external_id(p_external_tenant) || ':' || nopm_mask_external_id(p_external_user_id);

  -- Conflict checks BEFORE the code is burned, so a refused link leaves the code usable.
  select id, profile_id into v_same from external_identities
   where workspace_id = p_workspace_id and connector_id = p_connector_id
     and external_tenant = p_external_tenant and external_user_id = p_external_user_id and revoked_at is null;
  if found then
    if v_same.profile_id <> v_prof.id then
      return jsonb_build_object('status', 'conflict', 'reason', 'account_taken');
    end if;
    -- Re-confirming an existing link is a pure no-op: nothing linked, pinned, burned or audited.
    return jsonb_build_object('status', 'linked', 'already_linked', true, 'profile_label', v_label);
  end if;

  -- A code never REPLACES an existing link: the code is spent and the refused attempt is recorded.
  select id, external_tenant, external_user_id into v_held from external_identities
   where workspace_id = p_workspace_id and connector_id = p_connector_id and profile_id = v_prof.id and revoked_at is null
   limit 1;
  if found then
    begin
      update identity_link_codes set used_at = now()
       where id = v_code.id and workspace_id = p_workspace_id and used_at is null;
      perform nopm_audit_insert(
        p_workspace_id, p_audit || jsonb_build_object('action', 'integration.identity.link.blocked'), v_held.id, null,
        jsonb_build_object('connector_id', v_conn.id, 'provider', v_conn.kind, 'profile_id', v_prof.id,
                           'reason', 'profile_already_linked', 'external_ref', v_ref,
                           'existing_external_ref', v_conn.kind || ':' || nopm_mask_external_id(v_held.external_tenant)
                                                    || ':' || nopm_mask_external_id(v_held.external_user_id)));
    exception when others then
      null;  -- best effort: a refusal changes nothing, so a failing audit write must not turn it into an error
    end;
    return jsonb_build_object('status', 'conflict', 'reason', 'already_linked');
  end if;

  begin
    -- Tenant pin on the first NEW link, only by an admin or manager (any member can mint a code).
    if v_prof.role in ('admin', 'manager') and v_conn.tenant_key is null then
      update integration_connectors set tenant_key = p_external_tenant
       where id = v_conn.id and workspace_id = p_workspace_id and tenant_key is null;
      v_pinned := true;
    end if;

    update identity_link_codes set used_at = now()
     where id = v_code.id and workspace_id = p_workspace_id and used_at is null;

    with revoked as (
      update external_identities set revoked_at = now()
       where workspace_id = p_workspace_id and connector_id = p_connector_id
         and profile_id = v_prof.id and revoked_at is null
       returning external_tenant, external_user_id
    )
    select coalesce(jsonb_agg(jsonb_build_object('external_tenant', external_tenant, 'external_user_id', external_user_id)), '[]'::jsonb)
      into v_replaced from revoked;

    insert into external_identities (workspace_id, connector_id, provider, external_tenant, external_user_id,
                                     external_union_id, display_name, profile_id)
      values (p_workspace_id, p_connector_id, v_conn.kind, p_external_tenant, p_external_user_id,
              p_external_union_id, p_display_name, v_prof.id)
      returning id into v_new;
  exception when unique_violation then
    -- Lost a race for the same platform account: the sub-transaction undid the pin, the burn and the revoke.
    return jsonb_build_object('status', 'conflict', 'reason', 'duplicate');
  end;

  perform nopm_audit_insert(
    p_workspace_id, p_audit, v_new,
    case when jsonb_array_length(v_replaced) > 0
         then jsonb_build_object('external_ref', v_conn.kind || ':' || nopm_mask_external_id(v_replaced -> 0 ->> 'external_tenant')
                                                  || ':' || nopm_mask_external_id(v_replaced -> 0 ->> 'external_user_id'))
         else null end,
    jsonb_build_object('connector_id', v_conn.id, 'provider', v_conn.kind, 'profile_id', v_prof.id,
                       'external_ref', v_ref, 'replaced_previous_link', jsonb_array_length(v_replaced) > 0,
                       'tenant_pinned', v_pinned));

  return jsonb_build_object(
    'status', 'linked', 'already_linked', false, 'profile_label', v_label, 'profile_id', v_prof.id,
    'displaced', coalesce((select jsonb_agg(d) from jsonb_array_elements(v_replaced) d
                            where not (d ->> 'external_tenant' = p_external_tenant and d ->> 'external_user_id' = p_external_user_id)),
                          '[]'::jsonb));
end;
$$;

-- ── grants: service role only ─────────────────────────────────────────────────

revoke execute on function nopm_mask_external_id(text) from public, anon, authenticated;
revoke execute on function nopm_lark_connector_audit_view(integration_connectors, jsonb) from public, anon, authenticated;
revoke execute on function nopm_mfa_enroll(uuid, uuid, text, boolean, jsonb) from public, anon, authenticated;
revoke execute on function nopm_mfa_challenge(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function nopm_mfa_verify(uuid, uuid, text, text[], jsonb) from public, anon, authenticated;
revoke execute on function nopm_mfa_disable(uuid, uuid, text, boolean, jsonb) from public, anon, authenticated;
revoke execute on function nopm_connector_write(uuid, text, uuid, jsonb, uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function nopm_github_connector_write(uuid, text, uuid, text, text, text, boolean, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function nopm_revoke_other_invites(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function nopm_link_identity(uuid, uuid, text, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function nopm_mask_external_id(text) to service_role;
grant execute on function nopm_lark_connector_audit_view(integration_connectors, jsonb) to service_role;
grant execute on function nopm_mfa_enroll(uuid, uuid, text, boolean, jsonb) to service_role;
grant execute on function nopm_mfa_challenge(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function nopm_mfa_verify(uuid, uuid, text, text[], jsonb) to service_role;
grant execute on function nopm_mfa_disable(uuid, uuid, text, boolean, jsonb) to service_role;
grant execute on function nopm_connector_write(uuid, text, uuid, jsonb, uuid, jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function nopm_github_connector_write(uuid, text, uuid, text, text, text, boolean, uuid, jsonb, jsonb, jsonb) to service_role;
grant execute on function nopm_revoke_other_invites(uuid, text, uuid, jsonb) to service_role;
grant execute on function nopm_link_identity(uuid, uuid, text, uuid, text, text, text, text, jsonb) to service_role;

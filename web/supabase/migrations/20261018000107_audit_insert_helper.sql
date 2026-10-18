-- NoPM · 0107 (2026-10-18) — the one shared SQL helper that writes ONE audit_log row (M1 close-out, Pre-0).
--
-- WHY. Wave 5 adds about fifteen dedicated RPCs (change requests, deletion requests, MFA, connectors,
-- identity links, clash detect, overspend, weekly report, anchor and more). Each must write its change
-- and its audit row in the SAME transaction. Without a shared helper every RPC would copy the 17-column
-- insert of 0103 (nopm_mutate_audited) and drift. This function is that insert, once.
--
-- WHAT. nopm_audit_insert(p_workspace_id, p_audit, p_target_id, p_before, p_after) inserts exactly one
-- audit_log row and returns its id. p_audit is the same object the TypeScript side builds with
-- buildAuditArg() (web/src/lib/audit/audited-write.ts): action, target_type, actor_type, actor_id,
-- actor_label, channel, request_id, principal_id, via_connector_id, external_event_id, external_actor_ref.
-- before / after / target id are explicit parameters (the RPC knows the real rows; the caller does not).
-- The helper NEVER sets prev_hash, row_hash or chain_seq: the 0104 trigger trg_audit_chain fills them
-- under the per-workspace advisory lock.
--
-- ACTORS. user: actor_type 'user', actor_id the profile, principal = the same profile.
-- token / connector: actor_type 'token', actor_id the token or connector id, principal the human behind it,
-- via_connector_id / external_event_id / external_actor_ref when a connector relayed the action.
-- system (unattended jobs): actor_type 'token', actor_id the nil uuid, actor_label 'system:<label>',
-- principal NULL (see systemActor() in web/src/lib/audit/write.ts). The nil uuid is accepted ONLY with
-- actor_type 'token', a 'system:' label and no principal, so nothing else can pose as the system.
--
-- VALIDATION (mirrors the TypeScript side). action is verb.noun lower-case, e.g. 'task.create' or
-- 'task.update.blocked' (same pattern as every entry of action-glossary.ts); channel is one of
-- ui, api, cli, mcp, assistant, lark, github (same set as 0103 and channel.ts) or NULL.
-- Error codes: P0005 INVALID_CHANNEL (as 0103), P0057 INVALID_ACTION, P0058 INVALID_ACTOR, P0059 INVALID_AUDIT.
--
-- WHO CALLS IT (wave 5, all inside the caller's transaction): nopm_raise_change_request,
-- nopm_edit_change_request, nopm_withdraw_change_request, nopm_propose_rebaseline, nopm_request_deletion,
-- nopm_withdraw_deletion_request, nopm_reopen_deletion_request (0108); nopm_mfa_enroll, nopm_mfa_challenge,
-- nopm_mfa_verify, nopm_mfa_disable, nopm_connector_write, nopm_github_connector_write,
-- nopm_revoke_other_invites, nopm_link_identity (0109); the clash, overspend and weekly-report RPCs (0110);
-- the five delete-request and commit RPCs (0112); the anchor job (0113).
--
-- SAFETY. security definer with search_path pinned to public; executable by service_role only. p_audit is
-- TRUSTED input, like in 0103. Additive: this file creates one function and nothing else, so it is safe on
-- the live rows at ledger 0106. Safe to re-run (create or replace).
--
-- ORDER OF APPLY. Before 0108 (which calls it). Safe with the old build.
-- ROLLBACK. drop function nopm_audit_insert(uuid, jsonb, uuid, jsonb, jsonb);

create or replace function nopm_audit_insert(
  p_workspace_id uuid,
  p_audit        jsonb,
  p_target_id    uuid  default null,
  p_before       jsonb default null,
  p_after        jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c_nil     constant uuid := '00000000-0000-0000-0000-000000000000';
  v_action  text;
  v_channel text;
  v_type    text;
  v_actor   uuid;
  v_label   text;
  v_princ   uuid;
  v_target_type text;
  v_id      uuid;
begin
  if p_workspace_id is null or p_audit is null or jsonb_typeof(p_audit) <> 'object' then
    raise exception 'INVALID_AUDIT: workspace and an audit object are required' using errcode = 'P0059';
  end if;

  v_action  := p_audit ->> 'action';
  v_channel := nullif(p_audit ->> 'channel', '');
  v_type    := p_audit ->> 'actor_type';
  v_actor   := nullif(p_audit ->> 'actor_id', '')::uuid;
  v_label   := p_audit ->> 'actor_label';
  v_princ   := nullif(p_audit ->> 'principal_id', '')::uuid;
  v_target_type := nullif(p_audit ->> 'target_type', '');

  if v_action is null or v_action !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
    raise exception 'INVALID_ACTION: %', coalesce(v_action, 'null') using errcode = 'P0057';
  end if;
  if v_channel is not null and v_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark', 'github') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if v_target_type is null then
    raise exception 'INVALID_AUDIT: target_type is required' using errcode = 'P0059';
  end if;
  if v_type is null or v_type not in ('user', 'token') then
    raise exception 'INVALID_ACTOR: actor_type must be user or token' using errcode = 'P0058';
  end if;
  if v_label is null or btrim(v_label) = '' then
    raise exception 'INVALID_ACTOR: actor_label is required' using errcode = 'P0058';
  end if;
  if v_type = 'user' and v_actor is null then
    raise exception 'INVALID_ACTOR: a user actor needs an id' using errcode = 'P0058';
  end if;
  -- The system actor (unattended job): nil uuid, token type, a system: label, no human principal.
  if v_actor = c_nil and (v_type <> 'token' or v_label not like 'system:%' or v_princ is not null) then
    raise exception 'INVALID_ACTOR: the nil actor id is reserved for the system actor' using errcode = 'P0058';
  end if;

  -- prev_hash, row_hash and chain_seq are NOT set here: trg_audit_chain (0104) fills them.
  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id,
                         before, after, channel, request_id, principal_id,
                         via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id,
            v_type::actor_type,
            v_actor,
            v_label,
            v_action,
            v_target_type,
            p_target_id,
            p_before, p_after,
            v_channel,
            nullif(p_audit ->> 'request_id', ''),
            v_princ,
            nullif(p_audit ->> 'via_connector_id', '')::uuid,
            nullif(p_audit ->> 'external_event_id', ''),
            nullif(p_audit ->> 'external_actor_ref', ''))
    returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function nopm_audit_insert(uuid, jsonb, uuid, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function nopm_audit_insert(uuid, jsonb, uuid, jsonb, jsonb) to service_role;

comment on function nopm_audit_insert(uuid, jsonb, uuid, jsonb, jsonb) is
  'Wave 5 shared helper: writes ONE audit_log row inside the caller transaction. p_audit is built by buildAuditArg()/buildRpcAudit() in web/src/lib/audit. The 0104 trigger fills the hash chain. p_audit is trusted input.';

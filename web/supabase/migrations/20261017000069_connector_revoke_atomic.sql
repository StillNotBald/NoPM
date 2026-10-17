-- NoPM · 0069 (2026-10-17) — connector revoke is ONE transaction (D-ACC-6).
--
-- WHY. DELETE /api/integrations/connectors/[id] used to run four separate
-- writes from the route: mark the connector revoked, unlink the identities,
-- supersede the queued deliveries, drop the unused link codes, and only then
-- write the audit row. A failure between them left the connector revoked while
-- linked accounts stayed active and queued messages stayed pending, with a 500
-- and no audit row.
--
-- WHAT. nopm_revoke_connector does all of it plus the single audit row inside
-- one function call (= one transaction): either everything is revoked and
-- audited, or nothing changed. The route passes the connector's before/after
-- audit views (already masked by toAuditConnector); the function adds the two
-- counts to `after`.
--
-- ERRORS (raised, message = code):
--   CONNECTOR_NOT_FOUND  no such connector in that workspace
--   CONNECTOR_REVOKED    it was already revoked (a concurrent revoke lost)
--
-- Service-role only, pinned search_path, like the other governed RPCs.
-- ROLLBACK. drop function nopm_revoke_connector(uuid, uuid, text, uuid, text, jsonb, jsonb, timestamptz, text, text);

create or replace function nopm_revoke_connector(
  p_workspace_id   uuid,
  p_connector_id   uuid,
  p_actor_type     text,
  p_actor_id       uuid,
  p_actor_label    text,
  p_before         jsonb,
  p_after          jsonb,
  p_revoked_at     timestamptz default now(),
  p_channel        text default null,
  p_correlation_id text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_status     text;
  v_identities int := 0;
  v_deliveries int := 0;
begin
  select status into v_status
    from integration_connectors
   where id = p_connector_id and workspace_id = p_workspace_id
   for update;
  if not found then
    raise exception 'CONNECTOR_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status = 'revoked' then
    raise exception 'CONNECTOR_REVOKED' using errcode = 'P0001';
  end if;

  -- The connector first: this alone stops inbound and outbound.
  update integration_connectors
     set status = 'revoked', revoked_at = p_revoked_at
   where id = p_connector_id and workspace_id = p_workspace_id;

  update external_identities
     set revoked_at = p_revoked_at
   where workspace_id = p_workspace_id and connector_id = p_connector_id and revoked_at is null;
  get diagnostics v_identities = row_count;

  update integration_deliveries
     set status = 'superseded', last_error = 'connector revoked', locked_until = null
   where workspace_id = p_workspace_id and connector_id = p_connector_id
     and status in ('pending', 'retry');
  get diagnostics v_deliveries = row_count;

  delete from identity_link_codes
   where workspace_id = p_workspace_id and connector_id = p_connector_id and used_at is null;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after, channel, request_id)
    values (p_workspace_id, p_actor_type::actor_type, p_actor_id, p_actor_label,
            'integration.connector.revoke', 'integration_connector', p_connector_id,
            p_before,
            coalesce(p_after, '{}'::jsonb) || jsonb_build_object(
              'identities_revoked', v_identities,
              'deliveries_superseded', v_deliveries),
            p_channel, p_correlation_id);

  return jsonb_build_object('identities_revoked', v_identities, 'deliveries_superseded', v_deliveries);
end;
$$;

revoke execute on function nopm_revoke_connector(uuid, uuid, text, uuid, text, jsonb, jsonb, timestamptz, text, text) from public, anon, authenticated;
grant  execute on function nopm_revoke_connector(uuid, uuid, text, uuid, text, jsonb, jsonb, timestamptz, text, text) to service_role;

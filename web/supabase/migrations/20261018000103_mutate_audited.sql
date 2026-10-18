-- NoPM · 0103 (2026-10-18) — one generic RPC: a governed write and its audit row
-- succeed or fail together (audit M1, owner answer Q-GOV-23 "all-or-nothing").
--
-- WHY. About 59 route handlers wrote the change first and called writeAudit()
-- afterwards. A failure between the two left a change the trail never saw.
-- WHAT. nopm_mutate_audited() performs ONE insert / update / delete on a
-- registered table, scoped to the caller's workspace, and inserts exactly one
-- audit_log row in the same transaction (a plpgsql function body is one
-- transaction: any raise rolls both back). The TS wrapper is
-- web/src/lib/audit/audited-write.ts.
--
-- WHICH TABLES AND COLUMNS. The table nopm_mutate_audited_tables is the
-- allowlist (one row per table). Per table it names the key column (id, or
-- project_id for project_budget), the workspace column, and the columns that
-- may be written on insert and on update (NULL = every column except id,
-- workspace_id, created_at). The sensitive tables are narrowed: profiles can
-- only change display_name / avatar_url, api_tokens / invites /
-- assistant_credentials only their lifecycle columns on update. A later
-- migration adds a table (or narrows one) with an INSERT ... ON CONFLICT on
-- that table; it must never recreate the function.
--
-- SAFETY. The table name is looked up in the allowlist and quoted with
-- format('%I'). Every key of p_patch is checked against
-- information_schema.columns for that table (UNKNOWN_COLUMN) and against the
-- table's writable columns (FORBIDDEN_COLUMN); id, workspace_id, created_at
-- and the key column are never writable. The function sets the workspace
-- itself and matches rows on it, so a caller can never touch another
-- workspace. Values go through jsonb_populate_record, never concatenated.
-- p_audit is TRUSTED input (action, actor and any before / after override are
-- recorded as given): the function is executable by service_role only, and
-- the TS wrapper is the only caller.
-- Error codes: P0002 NOT_FOUND, P0051 STALE_ROW, P0052 UNKNOWN_COLUMN,
--   P0053 TABLE_NOT_ALLOWED, P0054 FORBIDDEN_COLUMN, P0055 INVALID_OP,
--   P0056 NO_UPDATED_AT, P0005 INVALID_CHANNEL.
-- p_audit may also carry before / after / target_id / after_extra overrides,
-- omit_columns and require_null (see the body).
--
-- ORDER OF APPLY. Apply BEFORE deploying the build that calls it.
-- ROLLBACK. drop function nopm_mutate_audited(text, text, uuid, uuid, jsonb, timestamptz, jsonb);
--           drop table nopm_mutate_audited_tables;

create table if not exists nopm_mutate_audited_tables (
  table_name       text primary key,
  key_column       text not null default 'id',
  workspace_column text not null default 'workspace_id',
  insert_columns   text[],   -- NULL = every column except id / workspace_id / created_at
  update_columns   text[]    -- NULL = every column except id / workspace_id / created_at
);

alter table nopm_mutate_audited_tables enable row level security;
revoke all on nopm_mutate_audited_tables from public, anon, authenticated;
grant select on nopm_mutate_audited_tables to service_role;

comment on table nopm_mutate_audited_tables is
  'Allowlist of tables nopm_mutate_audited may write, with per-table key column and writable columns. Extend with INSERT ... ON CONFLICT; never recreate the function for it.';

insert into nopm_mutate_audited_tables (table_name) values
  ('projects'), ('milestones'), ('tasks'), ('risks'), ('issues'), ('clashes'), ('programs'),
  ('sprints'), ('allocations'), ('expenses'), ('resource_members'), ('saved_views'),
  ('calendar_feeds'), ('documents'), ('decisions'), ('notifications'),
  ('integration_connectors'), ('external_identities'),
  ('project_dependencies'), ('task_dependencies')
on conflict (table_name) do nothing;

insert into nopm_mutate_audited_tables (table_name, key_column) values ('project_budget', 'project_id')
on conflict (table_name) do nothing;

-- Sensitive tables: narrowed. profiles are never created or role-changed through this function.
insert into nopm_mutate_audited_tables (table_name, insert_columns, update_columns) values
  ('profiles', '{}', array['display_name', 'avatar_url']),
  ('api_tokens', null, array['label', 'revoked', 'revoked_at', 'expires_at', 'last_used_at']),
  ('invites', null, array['revoked', 'revoked_at', 'expires_at', 'renewed_at', 'status']),
  ('assistant_credentials', null, array['provider', 'model', 'api_key_enc', 'updated_at'])
on conflict (table_name) do nothing;

drop function if exists nopm_mutate_audited(text, text, uuid, uuid, jsonb, timestamptz, jsonb);

create or replace function nopm_mutate_audited(
  p_table               text,
  p_op                  text,
  p_workspace_id        uuid,
  p_id                  uuid,
  p_patch               jsonb,
  p_expected_updated_at timestamptz,
  p_audit               jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_forbidden constant text[] := array['id', 'workspace_id', 'created_at'];
  v_cfg     nopm_mutate_audited_tables%rowtype;
  v_key_col text;
  v_ws_col  text;
  v_patch   jsonb := coalesce(p_patch, '{}'::jsonb);
  v_key     text;
  v_cols    text;
  v_vals    text;
  v_sets    text;
  v_before  jsonb;
  v_after   jsonb;
  v_target  uuid;
  v_channel text := nullif(p_audit ->> 'channel', '');
  v_cur     timestamptz;
  v_omit         text[] := array(select jsonb_array_elements_text(coalesce(p_audit -> 'omit_columns', '[]'::jsonb)));
  v_audit_before jsonb;
  v_audit_after  jsonb;
  v_audit_target uuid;
begin
  select * into v_cfg from nopm_mutate_audited_tables where table_name = p_table;
  if p_table is null or not found then
    raise exception 'TABLE_NOT_ALLOWED: %', coalesce(p_table, 'null') using errcode = 'P0053';
  end if;
  v_key_col := v_cfg.key_column;
  v_ws_col  := v_cfg.workspace_column;

  if p_op is null or p_op not in ('insert', 'update', 'delete') then
    raise exception 'INVALID_OP' using errcode = 'P0055';
  end if;
  if p_workspace_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_channel is not null and v_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark', 'github') then
    raise exception 'INVALID_CHANNEL' using errcode = 'P0005';
  end if;
  if jsonb_typeof(v_patch) <> 'object' then
    raise exception 'UNKNOWN_COLUMN: patch must be an object' using errcode = 'P0052';
  end if;
  if p_op in ('update', 'delete') and p_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_op = 'delete' and v_patch <> '{}'::jsonb then
    raise exception 'UNKNOWN_COLUMN: a delete takes no patch' using errcode = 'P0052';
  end if;

  for v_key in select jsonb_object_keys(v_patch) loop
    if v_key = any (c_forbidden) or v_key = v_key_col or v_key = v_ws_col then
      raise exception 'FORBIDDEN_COLUMN: %', v_key using errcode = 'P0054';
    end if;
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = p_table and column_name = v_key
    ) then
      raise exception 'UNKNOWN_COLUMN: %.%', p_table, v_key using errcode = 'P0052';
    end if;
    if p_op = 'insert' and v_cfg.insert_columns is not null and not (v_key = any (v_cfg.insert_columns)) then
      raise exception 'FORBIDDEN_COLUMN: %.% is not insertable here', p_table, v_key using errcode = 'P0054';
    end if;
    if p_op = 'update' and v_cfg.update_columns is not null and not (v_key = any (v_cfg.update_columns)) then
      raise exception 'FORBIDDEN_COLUMN: %.% is not updatable here', p_table, v_key using errcode = 'P0054';
    end if;
  end loop;

  if p_op = 'insert' then
    -- Only the keys the caller sent are written, so column defaults (id,
    -- created_at, status, ...) still apply to everything else.
    select string_agg(format('%I', k), ', '), string_agg(format('r.%I', k), ', ')
      into v_cols, v_vals
      from (select jsonb_object_keys(v_patch) as k
            union select v_ws_col
            union select v_key_col where p_id is not null) keys;
    execute format(
      'insert into %1$I (%2$s) select %3$s from jsonb_populate_record(null::%1$I, $1) r returning to_jsonb(%1$I.*)',
      p_table, v_cols, v_vals)
      into v_after
      using v_patch || jsonb_build_object(v_ws_col, p_workspace_id)
                    || case when p_id is not null then jsonb_build_object(v_key_col, p_id) else '{}'::jsonb end;
    v_before := null;
    v_target := (v_after ->> v_key_col)::uuid;
  else
    execute format(
      'select to_jsonb(t.*) from %I t where t.%I = $1 and t.%I = $2 for update', p_table, v_key_col, v_ws_col)
      into v_before using p_id, p_workspace_id;
    if v_before is null then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    if p_expected_updated_at is not null then
      -- A pin on a table that has no updated_at could never match; say so instead of answering STALE_ROW.
      if not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = p_table and column_name = 'updated_at'
      ) then
        raise exception 'NO_UPDATED_AT: % has no updated_at to compare', p_table using errcode = 'P0056';
      end if;
      v_cur := (v_before ->> 'updated_at')::timestamptz;
      -- millisecond comparison: the caller's value round-tripped through JSON
      if v_cur is null or date_trunc('milliseconds', v_cur) <> date_trunc('milliseconds', p_expected_updated_at) then
        raise exception 'STALE_ROW' using errcode = 'P0051';
      end if;
    end if;

    -- Compare-and-set on a nullable state column (p_audit.require_null, e.g. 'revoked_at'): the row
    -- must still have it NULL, so two concurrent callers cannot both make the same change.
    if nullif(p_audit ->> 'require_null', '') is not null then
      if not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = p_table and column_name = p_audit ->> 'require_null'
      ) then
        raise exception 'UNKNOWN_COLUMN: %.%', p_table, p_audit ->> 'require_null' using errcode = 'P0052';
      end if;
      if jsonb_typeof(v_before -> (p_audit ->> 'require_null')) <> 'null' then
        raise exception 'STALE_ROW' using errcode = 'P0051';
      end if;
    end if;

    if p_op = 'update' then
      select string_agg(format('%1$I = (jsonb_populate_record(null::%2$I, $1)).%1$I', k, p_table), ', ')
        into v_sets
        from (select jsonb_object_keys(v_patch) as k) keys;
      if v_sets is null then
        v_after := v_before;  -- empty patch: nothing to write, still audited
      else
        execute format(
          'update %1$I t set %2$s where t.%3$I = $2 and t.%4$I = $3 returning to_jsonb(t.*)',
          p_table, v_sets, v_key_col, v_ws_col)
          into v_after using v_patch, p_id, p_workspace_id;
      end if;
    else
      execute format('delete from %I t where t.%I = $1 and t.%I = $2', p_table, v_key_col, v_ws_col)
        using p_id, p_workspace_id;
      v_after := null;
    end if;
    v_target := p_id;
  end if;

  -- What the audit row records. By default the real before / after rows and the written row's id.
  -- A handler whose audit event is not "this row changed" (a sprint started, a task attached to a
  -- sprint) overrides them: p_audit.before / .after (JSON null = SQL null), .target_id, or adds
  -- context to the real after (.after_extra). The stored row and the returned rows are untouched.
  v_audit_before := case when p_audit ? 'before' then nullif(p_audit -> 'before', 'null'::jsonb) else v_before end;
  v_audit_after := case
    when p_audit ? 'after' then nullif(p_audit -> 'after', 'null'::jsonb)
    when v_after is not null and jsonb_typeof(p_audit -> 'after_extra') = 'object' then v_after || (p_audit -> 'after_extra')
    else v_after
  end;
  v_audit_target := coalesce(nullif(p_audit ->> 'target_id', '')::uuid, v_target);
  -- Secret-bearing columns (a token hash, an encrypted key) are kept out of the audit row AND out of
  -- the returned rows: p_audit.omit_columns.
  v_audit_before := v_audit_before - v_omit;
  v_audit_after := v_audit_after - v_omit;

  insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id,
                         before, after, channel, request_id, principal_id,
                         via_connector_id, external_event_id, external_actor_ref)
    values (p_workspace_id,
            (p_audit ->> 'actor_type')::actor_type,
            (p_audit ->> 'actor_id')::uuid,
            p_audit ->> 'actor_label',
            p_audit ->> 'action',
            coalesce(nullif(p_audit ->> 'target_type', ''), p_table),
            v_audit_target,
            v_audit_before, v_audit_after,
            v_channel,
            nullif(p_audit ->> 'request_id', ''),
            nullif(p_audit ->> 'principal_id', '')::uuid,
            nullif(p_audit ->> 'via_connector_id', '')::uuid,
            nullif(p_audit ->> 'external_event_id', ''),
            nullif(p_audit ->> 'external_actor_ref', ''));

  return jsonb_build_object('before', v_before - v_omit, 'after', v_after - v_omit);
end;
$$;

revoke execute on function nopm_mutate_audited(text, text, uuid, uuid, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant  execute on function nopm_mutate_audited(text, text, uuid, uuid, jsonb, timestamptz, jsonb) to service_role;

comment on function nopm_mutate_audited(text, text, uuid, uuid, jsonb, timestamptz, jsonb) is
  'Audit M1: one allowlisted insert/update/delete plus its audit_log row in a single transaction. Called by web/src/lib/audit/audited-write.ts. p_audit is trusted input.';

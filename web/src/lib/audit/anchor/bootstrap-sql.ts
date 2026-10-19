/**
 * The schema of the ANCHOR database (not the primary database). web/anchor-db/001_audit_anchors.sql
 * is this text plus the role grants; bootstrap-sql.test.ts pins that the file contains it verbatim.
 * The sink runs it only when the table is missing (first use), which succeeds only for a role that
 * may create objects; the production role is insert and select only, so there the owner runs the
 * file once (CUTOVER/13-AUDIT-ANCHOR.md).
 */
export const ANCHOR_TABLE_SQL = `
create table if not exists audit_anchors (
  id           bigserial primary key,
  workspace_id uuid        not null,
  chain_seq    bigint      not null,
  head_hash    text        not null,
  row_count    bigint      not null,
  anchored_at  timestamptz not null,
  source       text        not null default 'nopm',
  recorded_at  timestamptz not null default now(),
  constraint audit_anchors_source_check check (source in ('nopm', 'reset'))
);

-- One record per (workspace, chain_seq) for the app's own anchors. A 'reset' row (the owner
-- re-baselining after a legitimate restore) may sit at any position, even one already anchored.
create unique index if not exists audit_anchors_ws_seq_key on audit_anchors (workspace_id, chain_seq) where source <> 'reset';

create or replace function audit_anchors_append_only() returns trigger
language plpgsql as $fn$
begin
  raise exception 'audit_anchors is append-only: % is not allowed', tg_op using errcode = 'P0001';
end
$fn$;

do $tr$
begin
  if not exists (select 1 from pg_trigger where tgname = 'audit_anchors_no_change' and tgrelid = 'audit_anchors'::regclass) then
    create trigger audit_anchors_no_change before update or delete on audit_anchors
      for each row execute function audit_anchors_append_only();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'audit_anchors_no_truncate' and tgrelid = 'audit_anchors'::regclass) then
    create trigger audit_anchors_no_truncate before truncate on audit_anchors
      for each statement execute function audit_anchors_append_only();
  end if;
end
$tr$;
`.trim();

-- NoPM audit anchor database · 001_audit_anchors.sql
--
-- Run ONCE, as the owner of the SECOND database (not the NoPM database), before setting
-- NOPM_ANCHOR_DB_URL in the host. Steps and the role are in CUTOVER/13-AUDIT-ANCHOR.md.
--
-- WHAT IT HOLDS. One append-only table, audit_anchors: for each workspace, the chain_seq and row_hash
-- of the audit chain head at the time it was anchored (see web/src/lib/audit/anchor). The NoPM app can
-- only INSERT and SELECT here (role nopm_anchor); a trigger refuses UPDATE, DELETE and TRUNCATE for
-- every role, so even the app's own credentials cannot rewrite history. Only the owner of this database
-- (who should NOT be the owner of the NoPM database) could drop the trigger, and that is the point.
--
-- Re-runnable: everything is create-if-missing. The block between the markers is identical to
-- ANCHOR_TABLE_SQL in web/src/lib/audit/anchor/bootstrap-sql.ts (a test pins that).

-- BEGIN ANCHOR_TABLE_SQL
create table if not exists audit_anchors (
  id           bigserial primary key,
  workspace_id uuid        not null,
  chain_seq    bigint      not null,
  head_hash    text        not null,
  row_count    bigint      not null,
  anchored_at  timestamptz not null,
  source       text        not null default 'nopm',
  recorded_at  timestamptz not null default now(),
  constraint audit_anchors_ws_seq_key unique (workspace_id, chain_seq)
);

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

-- END ANCHOR_TABLE_SQL

-- The app role: INSERT and SELECT only (owner decision D12). Create the role first (see the CUTOVER
-- note: create role nopm_anchor login password '<generated>'); this block grants nothing until it exists.
do $grant$
begin
  if exists (select 1 from pg_roles where rolname = 'nopm_anchor') then
    revoke all on audit_anchors from nopm_anchor;
    revoke all on sequence audit_anchors_id_seq from nopm_anchor;
    grant select, insert on audit_anchors to nopm_anchor;
    grant usage on sequence audit_anchors_id_seq to nopm_anchor;
  else
    raise notice 'role nopm_anchor does not exist yet: create it, then run this file again to grant it';
  end if;
end
$grant$;

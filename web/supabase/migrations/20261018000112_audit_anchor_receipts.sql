-- NoPM · 0112 audit_anchor_receipts — primary-side bookkeeping for the external audit-chain anchor
-- (wave 5, W5-E, R-168..R-170; owner decision Q8 "a different database").
--
-- WHAT THE ANCHOR IS. The hash chain of 0104 proves the audit rows are consistent with each other, but
-- a database owner can delete the newest rows, or rewrite rows and recompute every later hash. The
-- defence is a copy of the chain head kept where that owner cannot write. The app writes
-- (workspace_id, chain_seq, head_hash, row_count, anchored_at) to a SECOND database (NOPM_ANCHOR_DB_URL,
-- role with INSERT and SELECT only; schema in web/anchor-db/001_audit_anchors.sql) and later compares
-- the live chain with it. That second database is the evidence. NOTHING in this migration is evidence.
--
-- WHAT THIS FILE ADDS. One table, audit_anchor_receipts: ONE ROW PER WORKSPACE holding the LAST anchor
-- this app recorded plus the current failure streak. It exists so the Trust Center can render the state
-- cheaply and so "one audit.anchor_failed / audit.anchor_mismatch row per streak" has somewhere to
-- remember the streak. It is NEVER read to decide a comparison; a person with write access to the
-- primary database can edit it freely, and that is harmless because the comparison reads the anchor
-- database only.
--   status             'anchored' (last attempt succeeded) | 'failed' (anchor database unreachable or
--                      refused the write) | 'mismatch' (the live chain differs from the anchor)
--   chain_seq/head_hash/row_count/anchored_at   the last SUCCESSFUL anchor (kept while a streak runs)
--   error_text         short message of the current failure (never a connection string)
--   streak_started_at  when the current non-anchored status began; null while status = 'anchored'
--
-- ACCESS (as 0048/0101). RLS on; select for an admin or manager of the workspace; no write policy;
-- insert, update and delete revoked from anon and authenticated, so only the service role writes.
--
-- SAFE ON LIVE ROWS. Additive: one new table, no change to any existing object, no backfill (a workspace
-- with no row simply reads "not anchored"). Re-runnable (if not exists / drop policy if exists).
-- Safe with the old build (it never reads this table). Apply BEFORE the build that reads it.
--
-- ROLLBACK. Remove the table audit_anchor_receipts (the anchor database is untouched; unset
-- NOPM_ANCHOR_DB_URL to stop anchoring).

create table if not exists audit_anchor_receipts (
  workspace_id      uuid primary key references workspaces(id) on delete cascade,
  status            text not null default 'anchored',
  chain_seq         bigint,
  head_hash         text,
  row_count         bigint,
  anchored_at       timestamptz,
  error_text        text,
  streak_started_at timestamptz,
  updated_at        timestamptz not null default now()
);

do $$
begin
  alter table audit_anchor_receipts
    add constraint audit_anchor_receipts_status_check
    check (status in ('anchored', 'failed', 'mismatch')) not valid;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table audit_anchor_receipts validate constraint audit_anchor_receipts_status_check;
exception when others then
  raise exception 'audit_anchor_receipts_status_check could not be validated: %', sqlerrm;
end $$;

comment on table audit_anchor_receipts is
  'Wave 5 W5-E: last external anchor per workspace plus the current failure streak. Display and streak bookkeeping only; the evidence is the anchor database (NOPM_ANCHOR_DB_URL).';

alter table audit_anchor_receipts enable row level security;

-- Second layer (as 0048): even a future careless write policy cannot open this to the browser.
revoke all on audit_anchor_receipts from anon;
revoke insert, update, delete, truncate on audit_anchor_receipts from authenticated;
grant select on audit_anchor_receipts to authenticated;

drop policy if exists "read audit_anchor_receipts" on audit_anchor_receipts;
create policy "read audit_anchor_receipts" on audit_anchor_receipts
  for select using (
    workspace_id = nopm_current_workspace()
    and exists (
      select 1 from profiles p
       where p.id = auth.uid() and p.workspace_id = audit_anchor_receipts.workspace_id
         and p.role in ('admin', 'manager')
    )
  );

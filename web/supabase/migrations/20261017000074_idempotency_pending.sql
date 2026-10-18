-- NoPM · 0074 (2026-10-17) — idempotency_keys: reserve-before-run (review R-3).
--
-- WHY. 0067 stored the result AFTER the create ran, so two simultaneous requests
-- with the same Idempotency-Key could both create. The key is now reserved first
-- as a 'pending' row (the unique index decides the winner), then marked 'done'
-- with the result. A request-body hash lets the server answer 422 when a key is
-- reused with a different body. Rows that already exist were stored after the
-- fact, so they default to 'done'.
--
-- Idempotent and safe on the live DB: only adds nullable/defaulted columns and
-- relaxes NOT NULL; no data change.
-- ROLLBACK. delete pending rows; drop the purge function, the check, the two
-- columns; restore result NOT NULL.

alter table idempotency_keys
  add column if not exists status text not null default 'done';

alter table idempotency_keys
  add column if not exists request_hash text;

-- A pending reservation has no result yet.
alter table idempotency_keys
  alter column result drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'idempotency_keys_status_check' and conrelid = 'idempotency_keys'::regclass
  ) then
    alter table idempotency_keys
      add constraint idempotency_keys_status_check check (status in ('pending', 'done'));
  end if;
end $$;

-- Retention (review R-11): the 24-hour purge, callable by the existing cron.
create or replace function nopm_purge_idempotency_keys(p_older_than interval default interval '24 hours')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from idempotency_keys where created_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function nopm_purge_idempotency_keys(interval) from public, anon, authenticated;
grant execute on function nopm_purge_idempotency_keys(interval) to service_role;

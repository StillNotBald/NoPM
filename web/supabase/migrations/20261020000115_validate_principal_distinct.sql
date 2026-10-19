-- NoPM · 0115 validate_principal_distinct (2026-10-20, follow-up to 0045 / 0089).
--
-- WHY. 0045 added cr_principal_distinct (change_requests) and deletion_principal_distinct (deletion_requests) as
-- NOT VALID, and 0089 tried to validate them but swallows any failure ("left NOT VALID"). The post-release check of
-- v0.1.1 showed both still NOT VALID on the live database, and a read-only probe found no row that violates either
-- CHECK. A NOT VALID constraint already guards every new and updated row; validating it makes "no self-approval" a
-- fact about ALL rows, which is what the audit pack claims.
--
-- WHAT. For each of the two constraints: skip if it is already validated (re-runnable, second run is a no-op),
-- otherwise count the rows that violate the CHECK and raise a clear error naming the count BEFORE attempting the
-- validation, then VALIDATE CONSTRAINT (a SHARE UPDATE EXCLUSIVE lock: reads and writes continue). Unlike 0089 this
-- file FAILS LOUDLY: under `migrate --atomic` a violation rolls the whole run back and the ledger stays unchanged.
-- ts_principal_distinct is out of scope here (it is validated by 0089 where clean).
--
-- ROLLBACK. Not needed for data: a validated CHECK can be turned back with
--   alter table change_requests drop constraint cr_principal_distinct;  -- and re-add ... not valid
-- Migrations are forward-only.

do $$
declare
  c record;
  bad bigint;
begin
  for c in
    select * from (values
      ('change_requests'::text, 'cr_principal_distinct'::text,
       'decided_principal_id is not null and requested_principal_id is not null and decided_principal_id = requested_principal_id'::text),
      ('deletion_requests', 'deletion_principal_distinct',
       'approved_principal_id is not null and requested_principal_id is not null and approved_principal_id = requested_principal_id')
    ) as t(tbl, conname, violation)
  loop
    if not exists (
      select 1 from pg_constraint
      where conname = c.conname and conrelid = c.tbl::regclass and not convalidated
    ) then
      raise notice '0115: % already validated (or absent); nothing to do.', c.conname;
      continue;
    end if;

    execute format('select count(*) from %I where %s', c.tbl, c.violation) into bad;
    if bad > 0 then
      raise exception '0115: cannot validate % on %: % row(s) have the same requester and decider principal. Review them (they are past self-approvals), then decide how to record them; nothing was changed.',
        c.conname, c.tbl, bad;
    end if;

    execute format('alter table %I validate constraint %I', c.tbl, c.conname);
    raise notice '0115: % validated on % (0 violating rows).', c.conname, c.tbl;
  end loop;
end $$;

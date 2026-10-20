-- NoPM · 0115 validate_principal_distinct (2026-10-20, follow-up to 0045 / 0089).
--
-- WHY. 0045 added cr_principal_distinct (change_requests) and deletion_principal_distinct (deletion_requests) as
-- NOT VALID, and 0089 tried to validate them but swallows any failure ("left NOT VALID"). The post-release check of
-- v0.1.1 showed both still NOT VALID on the live database. A NOT VALID constraint already guards every new and
-- updated row; validating it makes "no self-approval" a fact about ALL rows, which is what the audit pack claims.
--
-- THE LEGACY ROW. The 2026-10-20 dry run on live found one change request that breaks the rule: raised on
-- 2026-09-06 through the Slack bridge with its decider's own API token, then decided by that same person. Before
-- 0045 a token and a person counted as two actors; 0045 resolves a token to its creator, so the requester principal
-- that 0045 backfilled equals the decider. 0089 handles this case by leaving the requester principal unfilled
-- ("self-approval on record") so it never creates a violation, but 0045 had already filled it for token requesters.
-- The owner decided (2026-10-20) to record such rows the 0089 way.
--
-- WHAT.
--   1. RECORD. For every row that breaks either CHECK (by construction they predate 0045: the NOT VALID CHECK
--      refuses any later insert or update that would break it), write ONE audit_log row first
--      (action four_eyes.legacy_self_approval_recorded, system actor, before = the principals as stored), then set
--      requested_principal_id to NULL. Nothing else on the row changes: requested_by_*, the labels, the decision,
--      the timestamps and updated_at stay as they were (the updated_at trigger is paused for this step only, as in
--      0089). The audit row keeps the original value, so no evidence is lost. A RAISE NOTICE gives the count per
--      table; the release script expects exactly 1 on change_requests and 0 on deletion_requests.
--   2. VALIDATE. For each of the two constraints: skip if it is already validated (re-runnable, second run is a
--      no-op), otherwise count the rows that still violate the CHECK and raise a clear error naming the count, then
--      VALIDATE CONSTRAINT (a SHARE UPDATE EXCLUSIVE lock: reads and writes continue). Unlike 0089 this step FAILS
--      LOUDLY: under `migrate --atomic` a violation rolls the whole run back and the ledger stays unchanged.
-- ts_principal_distinct is out of scope here (it is validated by 0089 where clean).
--
-- ROLLBACK. Not needed for data: a validated CHECK can be turned back with
--   alter table change_requests drop constraint cr_principal_distinct;  -- and re-add ... not valid
-- A recorded row's original requester principal is in its four_eyes.legacy_self_approval_recorded audit row
-- (before.requested_principal_id). Migrations are forward-only.

alter table change_requests disable trigger trg_change_requests_updated;

do $$
declare
  c_nil constant uuid := '00000000-0000-0000-0000-000000000000';
  r record;
  n_cr int := 0;
  n_dr int := 0;
begin
  for r in
    select id, workspace_id, reference_id, requested_by_type, requested_by_id, requested_principal_id, decided_principal_id
      from change_requests
     where decided_principal_id is not null and requested_principal_id is not null
       and decided_principal_id = requested_principal_id
     order by created_at
  loop
    perform nopm_audit_insert(
      r.workspace_id,
      jsonb_build_object(
        'action', 'four_eyes.legacy_self_approval_recorded',
        'target_type', 'change_request',
        'actor_type', 'token',
        'actor_id', c_nil,
        'actor_label', 'system:migration-0115'
      ),
      r.id,
      jsonb_build_object(
        'reference_id', r.reference_id,
        'requested_by_type', r.requested_by_type,
        'requested_by_id', r.requested_by_id,
        'requested_principal_id', r.requested_principal_id,
        'decided_principal_id', r.decided_principal_id
      ),
      jsonb_build_object(
        'requested_principal_id', null,
        'reason', 'legacy self-approval (raised before 0045 with the decider''s own token); requester principal left unrecorded as in 0089 so the four-eyes CHECK can be validated'
      )
    );
    update change_requests set requested_principal_id = null where id = r.id;
    n_cr := n_cr + 1;
  end loop;

  for r in
    select id, workspace_id, requested_by_type, requested_by_id, requested_principal_id, approved_principal_id
      from deletion_requests
     where approved_principal_id is not null and requested_principal_id is not null
       and approved_principal_id = requested_principal_id
     order by created_at
  loop
    perform nopm_audit_insert(
      r.workspace_id,
      jsonb_build_object(
        'action', 'four_eyes.legacy_self_approval_recorded',
        'target_type', 'deletion_request',
        'actor_type', 'token',
        'actor_id', c_nil,
        'actor_label', 'system:migration-0115'
      ),
      r.id,
      jsonb_build_object(
        'requested_by_type', r.requested_by_type,
        'requested_by_id', r.requested_by_id,
        'requested_principal_id', r.requested_principal_id,
        'approved_principal_id', r.approved_principal_id
      ),
      jsonb_build_object(
        'requested_principal_id', null,
        'reason', 'legacy self-approval (raised before 0045); requester principal left unrecorded as in 0089 so the four-eyes CHECK can be validated'
      )
    );
    update deletion_requests set requested_principal_id = null where id = r.id;
    n_dr := n_dr + 1;
  end loop;

  raise notice '0115: recorded % legacy self-approval(s) on change_requests, % on deletion_requests.', n_cr, n_dr;
end $$;

alter table change_requests enable trigger trg_change_requests_updated;

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

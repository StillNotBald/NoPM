-- NoPM · 0089 four_eyes_backfill_validate (2026-10-18, audit gap G6 caveats).
--
-- THE GAP. Migration 0045 added the principal-distinct CHECKs
-- (cr_principal_distinct, deletion_principal_distinct, ts_principal_distinct) as
-- NOT VALID, so they only guard rows written after 0045. A decided request raised
-- before 0045 could carry requester = approver and the database would not say so,
-- and a legacy row whose requested_principal_id is NULL compares to nobody (the API
-- layer lets it through, see lib/governance/decide.ts). "No self-approval, ever"
-- was therefore a code claim, not a database fact.
--
-- WHAT THIS MIGRATION DOES
--   1. Backfills the requester principal on change_requests and deletion_requests
--      for every row still NULL, from evidence about the REQUESTER only:
--        - a user requester is their own principal (requested_by_id, or the legacy
--          requested_by profile column on change requests);
--        - a token requester takes api_tokens.created_by;
--        - a change request falls back to the principal stamped on its
--          change_request.create audit row;
--        - a deletion request falls back to the principal stamped on the RAISE row
--          (task.delete_requested / project.delete_requested on the task or project,
--          the latest one at or before the request was created).
--      A decision row is NEVER used: the audit rows of a deletion_request target are
--      written by the decision paths, so using them would stamp the decider as the
--      requester. Timesheet submitters follow the user / token rules.
--   2. Never creates a violation. If the derived requester equals the stored
--      decider / approver, the row is left unfilled and counted as "self-approval
--      on record". Every backfill statement also sits in its own exception block, so
--      one bad row can never abort the migration.
--   3. Reports in a RAISE NOTICE how many rows were derived and how many cannot be
--      derived (they stay NULL; the API writes a four_eyes.legacy_requester_unknown
--      audit row when one is decided, so an auditor can list them).
--   4. VALIDATE CONSTRAINT for each of the three CHECKs, each in its own exception
--      block that skips with a NOTICE. It never blocks a release.
--
-- Idempotent and additive (only NULL columns are filled; validating an already
-- valid constraint is a no-op). ROLLBACK: nothing to undo; a backfilled principal
-- is evidence, not behaviour. To re-open a constraint: alter table <t> drop
-- constraint <name>, then re-add it NOT VALID as in 0045.

-- The updated_at triggers would stamp every backfilled row "modified now", which
-- is a lie (nothing about the request changed). Paused for the backfill only.
alter table change_requests        disable trigger trg_change_requests_updated;
alter table timesheet_submissions  disable trigger trg_timesheet_submissions_updated;

-- Every candidate requester principal, best evidence first (lower rank wins).
-- (Dropped explicitly at the end, not ON COMMIT DROP, so it also works if the runner
-- executes statements outside one transaction.)
create temp table if not exists _fe_candidates (
  kind      text not null,   -- 'cr' | 'dr'
  id        uuid not null,
  rank      int  not null,
  principal uuid not null
);
truncate _fe_candidates;

insert into _fe_candidates (kind, id, rank, principal)
select 'cr', id, 1, requested_by_id from change_requests
  where requested_principal_id is null and requested_by_type = 'user' and requested_by_id is not null
union all
select 'cr', id, 2, requested_by from change_requests
  where requested_principal_id is null and requested_by is not null
union all
select 'cr', cr.id, 3, t.created_by from change_requests cr
  join api_tokens t on t.id = cr.requested_by_id
  where cr.requested_principal_id is null and cr.requested_by_type = 'token' and t.created_by is not null
union all
select 'cr', cr.id, 4, a.principal_id from change_requests cr
  join lateral (
    select principal_id from audit_log
     where target_type = 'change_request' and target_id = cr.id
       and action = 'change_request.create' and principal_id is not null
     order by created_at asc limit 1
  ) a on true
  where cr.requested_principal_id is null
union all
select 'dr', id, 1, requested_by_id from deletion_requests
  where requested_principal_id is null and requested_by_type = 'user' and requested_by_id is not null
union all
select 'dr', dr.id, 2, t.created_by from deletion_requests dr
  join api_tokens t on t.id = dr.requested_by_id
  where dr.requested_principal_id is null and dr.requested_by_type = 'token' and t.created_by is not null
union all
-- The RAISE row: task.delete_requested / project.delete_requested on the target.
select 'dr', dr.id, 3, a.principal_id from deletion_requests dr
  join lateral (
    select principal_id from audit_log
     where target_type = dr.target_type and target_id = dr.target_id
       and action = dr.target_type || '.delete_requested' and principal_id is not null
       and created_at <= dr.created_at
     order by created_at desc limit 1
  ) a on true
  where dr.requested_principal_id is null;

do $$
declare
  v_cr_before int; v_dr_before int; v_ts_before int;
  v_cr_after  int; v_dr_after  int; v_ts_after  int;
  v_cr_self   int := 0; v_dr_self int := 0;
begin
  select count(*) into v_cr_before from change_requests       where requested_principal_id is null;
  select count(*) into v_dr_before from deletion_requests     where requested_principal_id is null;
  select count(*) into v_ts_before from timesheet_submissions where submitted_principal_id is null;

  -- change_requests: best candidate per row, skipping a would-be self-approval.
  begin
    select count(*) into v_cr_self from change_requests cr
      join (select distinct on (id) id, principal from _fe_candidates where kind = 'cr' order by id, rank) c on c.id = cr.id
      where cr.requested_principal_id is null and cr.decided_principal_id is not null
        and cr.decided_principal_id = c.principal;
    update change_requests cr set requested_principal_id = c.principal
      from (select distinct on (id) id, principal from _fe_candidates where kind = 'cr' order by id, rank) c
      where c.id = cr.id and cr.requested_principal_id is null
        and (cr.decided_principal_id is null or cr.decided_principal_id <> c.principal);
  exception when others then
    raise notice '0089: change_requests backfill skipped (%).', sqlerrm;
  end;

  -- deletion_requests: same rule against the approver principal.
  begin
    select count(*) into v_dr_self from deletion_requests dr
      join (select distinct on (id) id, principal from _fe_candidates where kind = 'dr' order by id, rank) c on c.id = dr.id
      where dr.requested_principal_id is null and dr.approved_principal_id is not null
        and dr.approved_principal_id = c.principal;
    update deletion_requests dr set requested_principal_id = c.principal
      from (select distinct on (id) id, principal from _fe_candidates where kind = 'dr' order by id, rank) c
      where c.id = dr.id and dr.requested_principal_id is null
        and (dr.approved_principal_id is null or dr.approved_principal_id <> c.principal);
  exception when others then
    raise notice '0089: deletion_requests backfill skipped (%).', sqlerrm;
  end;

  -- timesheet_submissions: user submitter, then token submitter; never a self-approval.
  begin
    update timesheet_submissions set submitted_principal_id = submitted_by
      where submitted_principal_id is null and submitted_by_type = 'user' and submitted_by is not null
        and (decided_principal_id is null or decided_principal_id <> submitted_by);
  exception when others then
    raise notice '0089: timesheet user-submitter backfill skipped (%).', sqlerrm;
  end;
  begin
    update timesheet_submissions ts set submitted_principal_id = t.created_by
      from api_tokens t
      where ts.submitted_principal_id is null
        and ts.submitted_by_type = 'token' and ts.submitted_by = t.id
        and t.created_by is not null
        and (ts.decided_principal_id is null or ts.decided_principal_id <> t.created_by);
  exception when others then
    raise notice '0089: timesheet token-submitter backfill skipped (%).', sqlerrm;
  end;

  select count(*) into v_cr_after from change_requests       where requested_principal_id is null;
  select count(*) into v_dr_after from deletion_requests     where requested_principal_id is null;
  select count(*) into v_ts_after from timesheet_submissions where submitted_principal_id is null;

  raise notice '0089 four_eyes backfill: change_requests % -> % without a requester principal (% derived); deletion_requests % -> % (% derived); timesheet_submissions % -> % (% derived).',
    v_cr_before, v_cr_after, v_cr_before - v_cr_after,
    v_dr_before, v_dr_after, v_dr_before - v_dr_after,
    v_ts_before, v_ts_after, v_ts_before - v_ts_after;
  raise notice '0089 four_eyes backfill: self-approval on record, left unfilled: % change request(s), % deletion request(s).',
    v_cr_self, v_dr_self;
  raise notice '0089 four_eyes backfill: % change request(s), % deletion request(s) and % timesheet submission(s) still have no requester principal (listed at decision time by the four_eyes.legacy_requester_unknown audit action).',
    v_cr_after, v_dr_after, v_ts_after;
end $$;

drop table if exists _fe_candidates;

alter table change_requests        enable trigger trg_change_requests_updated;
alter table timesheet_submissions  enable trigger trg_timesheet_submissions_updated;

-- Validate each CHECK on its own. A failure is reported and skipped, never raised.
do $$
begin
  alter table change_requests validate constraint cr_principal_distinct;
  raise notice '0089: cr_principal_distinct validated.';
exception when others then
  raise notice '0089: cr_principal_distinct left NOT VALID (%). It still guards new writes.', sqlerrm;
end $$;

do $$
begin
  alter table deletion_requests validate constraint deletion_principal_distinct;
  raise notice '0089: deletion_principal_distinct validated.';
exception when others then
  raise notice '0089: deletion_principal_distinct left NOT VALID (%). It still guards new writes.', sqlerrm;
end $$;

do $$
begin
  alter table timesheet_submissions validate constraint ts_principal_distinct;
  raise notice '0089: ts_principal_distinct validated.';
exception when others then
  raise notice '0089: ts_principal_distinct left NOT VALID (%). It still guards new writes.', sqlerrm;
end $$;

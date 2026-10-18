-- NoPM · lark wave rollout · POST-WINDOW BACKFILL  (WRITES, idempotent)
--
-- What it does: re-runs the principal backfill of migration 0045 (section 2, copied verbatim, update
-- statements only fill columns that are still NULL). Rows the PREVIOUS build raised or decided between
-- the migration commit and the promote of the new build carry NULL principal columns: a NULL requester
-- principal makes a request approvable by any human, a NULL decider principal makes the principal CHECK
-- vacuous. This fills them from the actor (user id, or the token's created_by). The updated_at triggers
-- are paused for the run, exactly as in 0045, so existing rows are not re-stamped.
-- When to run: once, right AFTER the new build is promoted. Safe to repeat. Requests raised by a token
-- with no recorded creator stay NULL by design; the final SELECT counts them.
-- Keep in sync with 20261016000045_principal_four_eyes.sql section 2.

begin;
-- ── 2. backfill (retroactive for every actor) ─────────────────────────────

-- The updated_at triggers on these two tables would stamp every backfilled row
-- "modified now", which is a lie (nothing about the request changed) and would
-- invalidate every cached updated_at. Paused for the backfill only.
alter table change_requests        disable trigger trg_change_requests_updated;
alter table timesheet_submissions  disable trigger trg_timesheet_submissions_updated;

-- deletion_requests: requester
update deletion_requests set requested_principal_id = requested_by_id
  where requested_by_type = 'user' and requested_principal_id is null;
update deletion_requests dr set requested_principal_id = t.created_by
  from api_tokens t
  where dr.requested_by_type = 'token' and dr.requested_by_id = t.id
    and dr.requested_principal_id is null and t.created_by is not null;
-- deletion_requests: decider (approved / rejected / committed rows only)
update deletion_requests set approved_principal_id = approved_by_id
  where approved_by_type = 'user' and approved_by_id is not null and approved_principal_id is null;
update deletion_requests dr set approved_principal_id = t.created_by
  from api_tokens t
  where dr.approved_by_type = 'token' and dr.approved_by_id = t.id
    and dr.approved_principal_id is null and t.created_by is not null;

-- change_requests
update change_requests set requested_principal_id = requested_by_id
  where requested_by_type = 'user' and requested_principal_id is null;
update change_requests cr set requested_principal_id = t.created_by
  from api_tokens t
  where cr.requested_by_type = 'token' and cr.requested_by_id = t.id
    and cr.requested_principal_id is null and t.created_by is not null;
update change_requests set decided_principal_id = decided_by_id
  where decided_by_type = 'user' and decided_by_id is not null and decided_principal_id is null;
update change_requests cr set decided_principal_id = t.created_by
  from api_tokens t
  where cr.decided_by_type = 'token' and cr.decided_by_id = t.id
    and cr.decided_principal_id is null and t.created_by is not null;

-- timesheet_submissions
update timesheet_submissions set submitted_principal_id = submitted_by
  where submitted_by_type = 'user' and submitted_principal_id is null;
update timesheet_submissions ts set submitted_principal_id = t.created_by
  from api_tokens t
  where ts.submitted_by_type = 'token' and ts.submitted_by = t.id
    and ts.submitted_principal_id is null and t.created_by is not null;
update timesheet_submissions set decided_principal_id = decided_by
  where decided_by_type = 'user' and decided_by is not null and decided_principal_id is null;
update timesheet_submissions ts set decided_principal_id = t.created_by
  from api_tokens t
  where ts.decided_by_type = 'token' and ts.decided_by = t.id
    and ts.decided_principal_id is null and t.created_by is not null;

-- rebaselines: user-raised rows already name a profile (requested_by) ...
update rebaselines set requested_principal_id = requested_by
  where requested_by is not null and requested_principal_id is null;
-- ... token-raised rows stored NO actor (requested_by is user-only), but the
-- immutable audit row written at creation names the token that raised it.
update rebaselines r set requested_principal_id = t.created_by
  from audit_log a
  join api_tokens t on t.id = a.actor_id
  where a.workspace_id = r.workspace_id
    and a.action = 'rebaseline.create'
    and a.target_type = 'rebaseline'
    and a.target_id = r.id
    and a.actor_type = 'token'
    and r.requested_principal_id is null
    and t.created_by is not null;

-- rebaseline_signoffs: approver_id has always been a profile id
update rebaseline_signoffs set approver_principal_id = approver_id
  where approver_principal_id is null;

alter table change_requests        enable trigger trg_change_requests_updated;
alter table timesheet_submissions  enable trigger trg_timesheet_submissions_updated;

-- What is still unknown (no-creator tokens stay NULL by design):
select 'deletion_requests still NULL requester principal' what, count(*) from deletion_requests where requested_principal_id is null
union all select 'change_requests still NULL requester principal', count(*) from change_requests where requested_principal_id is null
union all select 'timesheet_submissions still NULL submitter principal', count(*) from timesheet_submissions where submitted_principal_id is null;
commit;

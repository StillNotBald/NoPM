-- NoPM · 0038 timesheet_submissions — four-eyes weekly timesheet approval
-- (L-31). Template B (change_requests pattern, recon-foureyes.md): approval
-- state lives ON the entity itself (status + submitted_by/decided_by/
-- decided_by_label/decided_at/decision_rationale), one *_maker_checker CHECK,
-- ONE POST /:id/decision route — no separate request table, no RPC. This is
-- a status transition, not a destructive commit, so it does NOT follow the
-- deletion_requests (Template A) shape.
--
-- hours_total/entry_count are a SNAPSHOT taken at submit time from
-- time_entries in [period_start, period_start + 6] for the member — they are
-- NOT recomputed if entries are edited/deleted afterwards (mirrors the
-- sprint snapshot precedent, migration 0037: written once, never rewritten
-- by a later edit to the source rows).
--
-- IDENTITY (recon-foureyes.md THREE BITES / (b)): submitted_by/decided_by
-- store the LOGIN identity (actor.id — profiles.id for a user session,
-- api_tokens.id for a token caller), mirroring change_requests.requested_by.
-- member_id is the separate WORK identity (resource_members.id, bridged via
-- resource_members.profile_id) — the four-eyes guard NEVER compares
-- member_id against actor.id, only submitted_by/submitted_by_type against
-- actor.id/actor.type (compound comparison — see ts_maker_checker below and
-- the API route guard in POST /timesheet-submissions/{id}/decision).
create table timesheet_submissions (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  member_id          uuid not null references resource_members(id) on delete cascade,
  period_start       date not null,
  period_end         date not null,
  hours_total        numeric(8, 2) not null default 0,  -- snapshot at submit time
  entry_count        int not null default 0,            -- snapshot at submit time
  status             text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  submitted_by       uuid not null,                      -- actor.id (profiles.id or api_tokens.id)
  submitted_by_type  actor_type not null default 'user',
  submitted_by_label text not null,
  submitted_at       timestamptz not null default now(),
  decided_by         uuid,
  decided_by_type    actor_type,
  decided_by_label   text,
  decided_at         timestamptz,
  decision_rationale text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Four-eyes (D2, f2b-specs.md): every terminal (non-'submitted') status
  -- requires a decider that differs from the submitter. Compound identity
  -- (submitted_by uuid alone) is the DB-level backstop; the API route
  -- additionally compares submitted_by_type so a user and a token that
  -- happen to share a uuid space boundary can never collide (belt-and-
  -- suspenders — see change_control.sql:29-33 for the pattern this copies).
  constraint ts_maker_checker check (
    status = 'submitted'
    or (decided_by is not null and decided_by <> submitted_by)
  ),
  constraint ts_period_is_one_week check (period_end = period_start + 6)
);

-- At most one OPEN (submitted or approved) submission per member+period —
-- resubmission after a rejection is explicitly allowed (a fresh row is
-- inserted; the rejected row stays as an immutable history entry).
create unique index uniq_open_timesheet
  on timesheet_submissions(member_id, period_start)
  where status in ('submitted', 'approved');

create index on timesheet_submissions(workspace_id);
create index on timesheet_submissions(status);

create trigger trg_timesheet_submissions_updated before update on timesheet_submissions
  for each row execute function nopm_set_updated_at();

-- ── RLS: READ policy only — deliberately NOT the house read/write pair. ────
-- Every write (submit + decision) MUST go through the audited API routes
-- (POST /api/timesheet-submissions, POST /api/timesheet-submissions/{id}/
-- decision) so the snapshot computation, four-eyes guard, and audit rows are
-- never bypassable via a direct PostgREST write. The Review Queue
-- (lib/review/gather.ts) and the /timesheets page both need to READ this
-- table through the RLS-scoped session client, hence the select policy —
-- but there is no insert/update/delete policy, so a direct write attempt
-- from the browser JWT is denied by RLS regardless of role, and only the
-- service-role admin client (used exclusively inside route() handlers) can
-- write here.
alter table timesheet_submissions enable row level security;

create policy "read timesheet_submissions" on timesheet_submissions for select using (
  workspace_id = nopm_current_workspace()
);

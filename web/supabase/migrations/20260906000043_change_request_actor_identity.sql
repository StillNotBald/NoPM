-- NoPM · 0043 change_request_actor_identity (R-83).
--
-- NoPM does not replace Jira, Slack or Teams; it is the governed record beside
-- them. Lite and fast. Not ClickUp. This migration brings change_requests'
-- four-eyes guard up to the same actor-typed shape already used by
-- deletion_requests / timesheet_submissions: requested_by / decided_by are
-- profile-id-only (uuid references profiles(id)), so a TOKEN or ASSISTANT
-- actor raising or deciding a change request has no identity recorded at all
-- — the maker-checker CHECK (`decided_by <> requested_by`) is silently inert
-- for any non-user actor pair (both sides NULL passes the CHECK, and a
-- token-raised, token-decided round trip is indistinguishable from a
-- token-raised, human-decided one).
--
-- Additive: requested_by_type/requested_by_id and decided_by_type/
-- decided_by_id (actor_type + uuid, mirroring timesheet_submissions'
-- submitted_by_type/decided_by_type pattern) carry the FULL actor identity
-- for both sides regardless of actor type. The legacy `requested_by` /
-- `decided_by` uuid columns are kept (API still sets them for user actors,
-- for any UI/report that joins straight to profiles) — this is additive,
-- not a rename.

alter table change_requests
  add column requested_by_type actor_type,
  add column requested_by_id   uuid,
  add column decided_by_type   actor_type,
  add column decided_by_id     uuid;

-- Backfill: every existing row was raised/decided by a user actor (tokens
-- could not raise change requests before this migration), so requested_by /
-- decided_by (profile ids) map straight across.
update change_requests
  set requested_by_type = 'user', requested_by_id = requested_by
  where requested_by is not null;

update change_requests
  set decided_by_type = 'user', decided_by_id = decided_by
  where decided_by is not null;

comment on column change_requests.requested_by_type is
  'actor type (user|token) that raised the request; NULL only for pre-0043 rows raised by an actor type this column did not yet capture';
comment on column change_requests.requested_by_id is
  'actor id that raised the request (profile id for user, token id for token); the API sets this unconditionally from 0043 on';
comment on column change_requests.decided_by_type is
  'actor type (user|token) that decided the request';
comment on column change_requests.decided_by_id is
  'actor id that decided the request (profile id for user, token id for token); the API sets this unconditionally from 0043 on';

-- Replace the maker-checker CHECK with the actor-typed form. The
-- `requested_by_id is null` branch is legacy NULL tolerance ONLY — it exists
-- so pre-0043 rows raised by a non-user actor (requested_by_id NULL because
-- the column didn't exist yet) don't retroactively violate the constraint.
-- Every row inserted by the API from 0043 on always sets requested_by_id
-- (see POST /api/projects/:id/change-requests), so for any current-generation
-- row this branch never applies — the constraint is fully actor-typed:
-- decided_by_id/type must differ from requested_by_id/type on either axis.
alter table change_requests drop constraint cr_maker_checker;

alter table change_requests
  add constraint cr_maker_checker check (
    status in ('raised', 'under_review')
    or (
      decided_by_id is not null
      and (
        requested_by_id is null
        or decided_by_id <> requested_by_id
        or decided_by_type <> requested_by_type
      )
    )
  );

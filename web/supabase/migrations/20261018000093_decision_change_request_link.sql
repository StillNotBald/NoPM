-- NoPM · 0093 decision_change_request_link (2026-10-18, audit gap B1).
--
-- THE GAP. A decision could name its project but not the change request it was
-- taken for, and its options were one free-text blob with no record of which
-- option was chosen.
--
-- THE FIX (additive; nothing is backfilled, so no updated_at trigger is paused).
--   1. decisions.change_request_id -> change_requests(id) ON DELETE SET NULL,
--      with an index. A decided change request can never be hard-deleted anyway
--      (API rule); SET NULL only keeps an open one from being blocked.
--   2. decisions.options_structured jsonb: an array of {label, chosen, note}.
--      The free-text `options` column stays; the API accepts and returns both.
--      The shape (at most one chosen) is validated by the API; the database only
--      insists on an array.
--
-- Workspace and project agreement of the link is enforced by the API
-- (assertRefsInWorkspace with a project match), like every other body reference.
--
-- ROLLBACK: alter table decisions drop constraint decisions_options_structured_array,
-- drop column options_structured, drop column change_request_id (index goes with it).

alter table decisions
  add column if not exists change_request_id   uuid references change_requests(id) on delete set null,
  add column if not exists options_structured  jsonb;

create index if not exists idx_decisions_change_request on decisions(change_request_id)
  where change_request_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'decisions_options_structured_array') then
    alter table decisions
      add constraint decisions_options_structured_array
      check (options_structured is null or jsonb_typeof(options_structured) = 'array');
  end if;
end $$;

comment on column decisions.change_request_id is 'the change request this decision was taken for (same workspace and project, enforced by the API)';
comment on column decisions.options_structured is 'array of {label, chosen boolean, note}; at most one chosen. The free-text options column stays alongside it.';

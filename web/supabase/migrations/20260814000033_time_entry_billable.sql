-- NoPM · 0033 — L-29: billable flag on time entries + a per-project default.
--
-- time_entries.billable: whether a logged entry should be counted as
-- billable to the client (vs internal/non-billable work). Defaults to true
-- so existing rows (and callers that omit the field) keep today's implicit
-- behavior — every hour was treated as billable before this migration.
--
-- projects.default_billable: the fallback the time-entries create route
-- applies when a caller omits `billable` on POST /time-entries (see
-- src/app/api/time-entries/route.ts) — lets a project mark its default
-- work as non-billable (e.g. an internal/overhead project) without every
-- caller having to pass billable=false on each entry.
--
-- Both NOT NULL with a DEFAULT so this is a same-transaction, no-backfill-
-- needed additive change (idiom matches 0028/0031 — additive columns with
-- a safe default, no data migration required).

alter table time_entries
  add column if not exists billable boolean not null default true;

alter table projects
  add column if not exists default_billable boolean not null default true;

comment on column time_entries.billable is
  'Whether this logged entry counts as billable to the client. Defaults from projects.default_billable at create time when the caller omits it (see POST /time-entries).';

comment on column projects.default_billable is
  'Default billable value applied to a time entry created under this project when the caller omits billable on POST /time-entries.';

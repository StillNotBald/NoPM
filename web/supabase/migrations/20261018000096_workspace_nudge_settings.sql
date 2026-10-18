-- NoPM · 0096 workspace nudge + weekly report settings (R-141, R-142; audit items A3, A4).
-- Four settings on workspaces, a once-per-day nudge ledger and a stored weekly report snapshot.
-- Additive only: no backfill, no row of any existing table changes except the four new defaults.

alter table workspaces
  add column if not exists stale_days            int      not null default 14,
  add column if not exists weekly_report_enabled boolean  not null default true,
  add column if not exists weekly_report_day     smallint not null default 1,
  add column if not exists nudges_enabled        boolean  not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_stale_days_check') then
    alter table workspaces add constraint workspaces_stale_days_check
      check (stale_days between 1 and 365);
  end if;
  -- ISO weekday in the workspace time zone: 1 = Monday ... 7 = Sunday.
  if not exists (select 1 from pg_constraint where conname = 'workspaces_weekly_report_day_check') then
    alter table workspaces add constraint workspaces_weekly_report_day_check
      check (weekly_report_day between 1 and 7);
  end if;
end $$;

comment on column workspaces.stale_days is 'Days without an update before a task, risk or issue counts as stale (1-365, default 14).';
comment on column workspaces.weekly_report_day is 'ISO weekday (1 = Monday ... 7 = Sunday) in the workspace time zone.';

-- One row per nudge actually raised. The unique index is the once-per-item-per-day rule:
-- two cron ticks (or a retried tick) on the same workspace day cannot notify twice.
create table if not exists nudge_log (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  target_type  text not null,
  target_id    uuid not null,
  kind         text not null check (kind in ('stale', 'weekly_report')),
  recipient_id uuid not null references profiles(id) on delete cascade,
  sent_on      date not null,
  sent_at      timestamptz not null default now()
);

create unique index if not exists nudge_log_once_per_day
  on nudge_log (workspace_id, kind, target_type, target_id, recipient_id, sent_on);
create index if not exists nudge_log_workspace_sent_idx
  on nudge_log (workspace_id, sent_at desc);

-- The report a weekly run produced, so GET /api/reports/weekly?week= shows what was sent
-- rather than today's figures under last week's heading. One row per workspace per ISO week;
-- "Send weekly report now" refreshes the row for the current week.
create table if not exists weekly_reports (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  week_start   date not null,
  data         jsonb not null,
  generated_at timestamptz not null default now(),
  generated_by text not null,
  unique (workspace_id, week_start)
);

-- RLS select-only, like the other server-written tables: the service-role cron and
-- API write; a signed-in member reads only their own workspace.
alter table nudge_log      enable row level security;
alter table weekly_reports enable row level security;

-- Second layer (as 0048): even a future careless write policy cannot open these to the browser.
revoke insert, update, delete on nudge_log      from anon, authenticated;
revoke insert, update, delete on weekly_reports from anon, authenticated;

drop policy if exists "read nudge_log" on nudge_log;
create policy "read nudge_log" on nudge_log
  for select using (workspace_id = nopm_current_workspace());
drop policy if exists "read weekly_reports" on weekly_reports;
create policy "read weekly_reports" on weekly_reports
  for select using (workspace_id = nopm_current_workspace());

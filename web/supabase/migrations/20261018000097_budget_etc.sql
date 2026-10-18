-- NoPM · 0097 forecast to complete (B3) + approver assignment (G5).
-- Audit gaps B3 and G5, change request CR-2026-10-18-01. Additive and idempotent;
-- no backfill, no trigger or policy touched.
--
-- B3: the forecast at completion is incurred + committed + to-finish.
--   estimate_to_complete  the manual "still to spend beyond what is committed" figure
--                         (null = nobody has estimated it yet).
--   forecast_method       which forecast the project reports as its EAC:
--                         'cpi' (BAC / CPI, the classic) or 'bottom_up'
--                         (actual + committed + estimate_to_complete).
--
-- G5: an optional named approver on each maker-checker request, so the pending
--   queue can be filtered "assigned to me". Nullable; nothing is routed
--   automatically in this wave (wave 4 may fill it). ON DELETE SET NULL: a removed
--   approver un-assigns the request instead of blocking the profile delete.

alter table project_budget
  add column if not exists estimate_to_complete numeric(14,2),
  add column if not exists forecast_method text not null default 'cpi',
  add column if not exists committed_open numeric(14,2);

-- committed_open: commitments NOT YET INVOICED. Null = "not tracked separately", and every
-- read then uses committed_amount. The bottom-up forecast is
-- actual (expenses) + open commitments + estimate_to_complete, so an invoiced commitment
-- is counted once (as an expense) as soon as the owner lowers committed_open.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_budget_etc_nonneg_chk') then
    alter table project_budget
      add constraint project_budget_etc_nonneg_chk
      check (estimate_to_complete is null or estimate_to_complete >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_budget_forecast_method_chk') then
    alter table project_budget
      add constraint project_budget_forecast_method_chk
      check (forecast_method in ('cpi', 'bottom_up')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_budget_committed_open_nonneg_chk') then
    alter table project_budget
      add constraint project_budget_committed_open_nonneg_chk
      check (committed_open is null or committed_open >= 0) not valid;
  end if;
end $$;

-- No existing row can violate these (new nullable column, constant default), so validate now.
-- Skip-on-failure, as in 0095: a surprise row must not abort the whole migration.
do $$
begin
  begin
    alter table project_budget validate constraint project_budget_etc_nonneg_chk;
    alter table project_budget validate constraint project_budget_forecast_method_chk;
    alter table project_budget validate constraint project_budget_committed_open_nonneg_chk;
  exception when others then
    raise notice 'project_budget forecast checks left NOT VALID: %', sqlerrm;
  end;
end $$;

alter table change_requests
  add column if not exists assigned_approver_id uuid references profiles(id) on delete set null;
alter table deletion_requests
  add column if not exists assigned_approver_id uuid references profiles(id) on delete set null;
alter table rebaselines
  add column if not exists assigned_approver_id uuid references profiles(id) on delete set null;

create index if not exists change_requests_assigned_approver_idx
  on change_requests (workspace_id, assigned_approver_id) where assigned_approver_id is not null;
create index if not exists deletion_requests_assigned_approver_idx
  on deletion_requests (workspace_id, assigned_approver_id) where assigned_approver_id is not null;
create index if not exists rebaselines_assigned_approver_idx
  on rebaselines (workspace_id, assigned_approver_id) where assigned_approver_id is not null;

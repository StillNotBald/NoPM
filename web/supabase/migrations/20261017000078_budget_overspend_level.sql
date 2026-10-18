-- NoPM · 0078 budget overspend level (decision 19, Q-WRK-7).
-- Warn when actual (expenses) passes a set % of plan (default 90 warn, 100 over).
-- The last level reported is remembered per project so exactly ONE audit row is
-- written per threshold crossing. Never blocks. Additive and idempotent.

alter table project_budget
  add column if not exists overspend_level text not null default 'ok',
  add column if not exists overspend_warn_pct int not null default 90;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_budget_overspend_level_chk') then
    alter table project_budget
      add constraint project_budget_overspend_level_chk
      check (overspend_level in ('ok', 'warn', 'over')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_budget_overspend_warn_pct_chk') then
    alter table project_budget
      add constraint project_budget_overspend_warn_pct_chk
      check (overspend_warn_pct between 1 and 100) not valid;
  end if;
end $$;

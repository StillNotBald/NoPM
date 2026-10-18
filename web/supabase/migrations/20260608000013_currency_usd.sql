-- Standardize currency on USD (international dataset). Flip DB defaults and
-- migrate any existing MYR rows. New records default to USD; the API/budget
-- layer already defaults USD.
alter table projects alter column currency set default 'USD';
alter table project_budget alter column currency set default 'USD';
update projects set currency = 'USD' where currency = 'MYR' or currency is null;
update project_budget set currency = 'USD' where currency = 'MYR' or currency is null;

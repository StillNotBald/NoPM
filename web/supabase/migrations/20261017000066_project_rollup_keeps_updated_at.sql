-- NoPM · 0066 — the task completion roll-up must not bump projects.updated_at.
--
-- nopm_recompute_project_completion() (0021) UPDATEs projects.completion_pct on
-- every task completion change. trg_projects_updated (0003, BEFORE UPDATE) then
-- stamped updated_at = now(), so a project edit form that was open while a task
-- changed got a false 412 "Record changed since you loaded it" on save
-- (optimistic concurrency compares updated_at).
--
-- Fix: give projects their own updated_at trigger function that keeps the old
-- updated_at when the ONLY column that changed is completion_pct (a derived
-- value). Any real edit still bumps it. The shared nopm_set_updated_at() used
-- by other tables is untouched. Idempotent; no data change.

create or replace function nopm_projects_set_updated_at()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (to_jsonb(new) - 'completion_pct' - 'updated_at')
       = (to_jsonb(old) - 'completion_pct' - 'updated_at') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_projects_updated on projects;
create trigger trg_projects_updated before update on projects
  for each row execute function nopm_projects_set_updated_at();

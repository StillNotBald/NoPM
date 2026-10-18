-- NoPM · 0080 work-record rules (common-pattern answers, owner "follow the
-- common pattern", 2026-10-17). Additive and safe on live data; no row is
-- deleted or rewritten except the one-off backfill in section 3.
--
--   Q-WRK-2   one LIVE clash per person and type. The API already refuses a
--             second one; this partial unique index is the race backstop (two
--             concurrent creates / two concurrent over-allocation detections).
--             Created ONLY when the existing data has no duplicate, otherwise
--             skipped with a notice (the API check still holds) — never fails.
--   Q-WRK-19  risks.resolution: the note that is required to close a risk
--             (issues already have a resolution column).
--   Q-WRK-27  tasks.content_updated_at: bumped only when the title, the dates or
--             the assignee change. A status drag (Kanban) bumps updated_at but
--             NOT this column, so it no longer voids a pending task-deletion
--             request. Backfilled from updated_at; trigger is additive.
-- ROLLBACK: drop index if exists uniq_live_clash_per_member_type;
--           alter table risks drop column if exists resolution;
--           drop trigger if exists trg_tasks_content_updated on tasks;
--           drop function if exists nopm_tasks_content_updated();
--           alter table tasks drop column if exists content_updated_at;

-- ── 1. Q-WRK-2 ────────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1
      from clashes
     where resource_member_id is not null
       and status in ('open', 'investigating')
     group by workspace_id, resource_member_id, type
    having count(*) > 1
  ) then
    raise notice '0080: duplicate live clashes exist; uniq_live_clash_per_member_type NOT created (the API still refuses new duplicates). Resolve the duplicates, then create the index by hand.';
  else
    execute 'create unique index if not exists uniq_live_clash_per_member_type
               on clashes (workspace_id, resource_member_id, type)
             where resource_member_id is not null and status in (''open'', ''investigating'')';
  end if;
end
$$;

-- ── 2. Q-WRK-19 ───────────────────────────────────────────────────────────
alter table risks add column if not exists resolution text;

-- ── 3. Q-WRK-27 ───────────────────────────────────────────────────────────
alter table tasks add column if not exists content_updated_at timestamptz;
-- The backfill must NOT run the stamp trigger: trg_tasks_updated would rewrite
-- updated_at on every live task (and void every pending task-deletion request,
-- which compares updated_at). Same in-transaction pattern as 0077: the runner
-- wraps the file in a transaction, so a failure restores the trigger.
alter table tasks disable trigger trg_tasks_updated;
update tasks set content_updated_at = updated_at where content_updated_at is null;
alter table tasks enable trigger trg_tasks_updated;
alter table tasks alter column content_updated_at set default now();
alter table tasks alter column content_updated_at set not null;

create or replace function nopm_tasks_content_updated()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.content_updated_at := coalesce(new.content_updated_at, now());
    return new;
  end if;
  if new.name         is distinct from old.name
     or new.start_date  is distinct from old.start_date
     or new.due_date    is distinct from old.due_date
     or new.assignee_id is distinct from old.assignee_id then
    new.content_updated_at := now();
  else
    new.content_updated_at := old.content_updated_at;
  end if;
  return new;
end;
$$;

revoke execute on function nopm_tasks_content_updated() from public, anon, authenticated;
grant  execute on function nopm_tasks_content_updated() to service_role;

drop trigger if exists trg_tasks_content_updated on tasks;
create trigger trg_tasks_content_updated
  before insert or update on tasks
  for each row execute function nopm_tasks_content_updated();

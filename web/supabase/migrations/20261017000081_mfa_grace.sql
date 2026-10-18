-- NoPM · 0081 (2026-10-17) — two-step grace clock for admins and managers (decision 22).
--
-- WHY. Two-step becomes required for admins and managers, with a 14-day grace
-- period that starts when a person becomes an admin/manager, or at this release
-- for the ones who already are. profiles.mfa_grace_started_at records that start.
-- A trigger keeps it right whatever path changes the role (API, SQL, seed):
--   * becomes admin/manager (insert, or role moves from member/viewer) -> now()
--   * stops being admin/manager                                         -> null
-- The 14-day length and the "send them to enrol" rule live in the app, not here.
-- The console redirect only reads this column; API tokens are unaffected.
--
-- Idempotent and safe on the live DB: one nullable column, a backfill that only
-- fills NULLs, one trigger. No existing row is deleted or re-roled.
-- ROLLBACK. remove the trigger nopm_profile_mfa_grace_trg and the function
-- nopm_profile_mfa_grace(), then the column profiles.mfa_grace_started_at.

alter table profiles add column if not exists mfa_grace_started_at timestamptz;

comment on column profiles.mfa_grace_started_at is
  'When this person became an admin/manager (or the 0081 release for existing ones). Start of the 14-day two-step grace. NULL for members and viewers.';

-- Current admins/managers start their grace at this release.
update profiles
   set mfa_grace_started_at = now()
 where role::text in ('admin', 'manager')
   and mfa_grace_started_at is null;

create or replace function nopm_profile_mfa_grace()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role::text in ('admin', 'manager') then
    if tg_op = 'INSERT' or old.role::text not in ('admin', 'manager') or new.mfa_grace_started_at is null then
      new.mfa_grace_started_at := now();
    end if;
  else
    new.mfa_grace_started_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists nopm_profile_mfa_grace_trg on profiles;
create trigger nopm_profile_mfa_grace_trg
  before insert or update of role on profiles
  for each row execute function nopm_profile_mfa_grace();

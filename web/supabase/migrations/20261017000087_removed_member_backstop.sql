-- 0087 - removed-member backstop (R3-3 / R3-2).
-- A removed person is banned (no sign-in, no refresh), but an access JWT issued
-- earlier stays valid until it expires and the RLS read policies never looked at
-- profiles.status. Both scope helpers now answer NULL for a profile that is not
-- 'active', so every policy built on them denies a removed member at once.
-- Bodies copied verbatim from 20260608000001_init.sql (the only definition) plus
-- the status check; security definer, search_path and grants unchanged by
-- create or replace. Needs 0083 (profiles.status). Idempotent.
-- Rollback: re-run the two functions from 20260608000001_init.sql.

create or replace function nopm_current_workspace()
returns uuid language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where id = auth.uid() and status = 'active'
$$;

create or replace function nopm_current_role()
returns member_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and status = 'active'
$$;

-- Best-effort session kill used on removal (service role only). Deleting the
-- auth.sessions rows stops refresh; refresh tokens cascade with them.
create or replace function nopm_revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function nopm_revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function nopm_revoke_user_sessions(uuid) to service_role;

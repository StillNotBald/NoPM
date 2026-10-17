-- NoPM · 0059 auth_hardening — two service-role-only helpers for the auth core fix wave (2026-10-17).
--
-- 1. nopm_rate_peek(key, max, window): READ-ONLY twin of nopm_rate_check. Returns
--    the same jsonb shape { allowed, remaining, retry_after_seconds } but never
--    increments. Used to ask "is this client already over its budget?" BEFORE
--    doing work (A1-8 / D-ACC-20: failed bearer auth is throttled per client
--    address BEFORE the token lookup; the failure itself is then counted with
--    nopm_rate_check). Same window alignment as 0050's nopm_rate_check.
--
-- 2. nopm_auth_user_for_invite(email): finds the auth user for an e-mail and says
--    whether it owns a profile. Lets POST /api/invites/accept finish a retry when
--    an earlier attempt created the auth user but the accept RPC then failed and
--    the clean-up did not run (D-ACC-3). auth.users is not reachable through
--    PostgREST, hence a SECURITY DEFINER function with a pinned search_path.
--
-- Both are idempotent (create or replace), change no data, and are granted to the
-- service role only.

create or replace function nopm_rate_peek(p_key text, p_max int, p_window_seconds int)
  returns jsonb
  language plpgsql
  stable
  set search_path = public
as $$
declare
  now_epoch numeric;
  win_epoch numeric;
  cur_hits  int;
begin
  if p_key is null or length(p_key) > 256 then
    raise exception 'nopm_rate_peek: key must be 1-256 characters' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'nopm_rate_peek: window must be 1-3600 seconds' using errcode = '22023';
  end if;

  now_epoch := extract(epoch from now())::numeric;
  win_epoch := floor(now_epoch / p_window_seconds) * p_window_seconds;

  select hits into cur_hits
    from nopm_rate_counters
   where rate_key = p_key and window_start = to_timestamp(win_epoch);

  if coalesce(cur_hits, 0) >= p_max then
    return jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'retry_after_seconds', greatest(1, ceil(win_epoch + p_window_seconds - now_epoch)::int)
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'remaining', greatest(0, p_max - coalesce(cur_hits, 0)),
    'retry_after_seconds', 0
  );
end;
$$;

revoke execute on function nopm_rate_peek(text, int, int) from public, anon, authenticated;
grant  execute on function nopm_rate_peek(text, int, int) to service_role;

create or replace function nopm_auth_user_for_invite(p_email text)
  returns table (user_id uuid, has_profile boolean)
  language sql
  stable
  security definer
  set search_path = public, auth
as $$
  select u.id, exists (select 1 from public.profiles p where p.id = u.id)
    from auth.users u
   where lower(u.email) = lower(p_email)
   limit 1
$$;

revoke execute on function nopm_auth_user_for_invite(text) from public, anon, authenticated;
grant  execute on function nopm_auth_user_for_invite(text) to service_role;

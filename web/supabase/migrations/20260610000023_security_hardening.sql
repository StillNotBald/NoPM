-- NoPM · 0023 — security hardening (defense-in-depth) from SECURITY-REVIEW-2026-06-10.

-- (1) Durable demo-LLM rate limit — a service-role-only counter so the owner-key
--     cap holds across serverless instances / cold starts (the in-memory Map did
--     not). nopm_demo_rate_check atomically advances the window under a row lock.
create table if not exists assistant_demo_usage (
  user_id      uuid primary key,
  window_start timestamptz not null default now(),
  count        int not null default 0
);
alter table assistant_demo_usage enable row level security;  -- no policies = service-role only

create or replace function nopm_demo_rate_check(p_user uuid, p_limit int, p_window_secs int)
  returns boolean
  language plpgsql
  set search_path = public
as $$
declare cur assistant_demo_usage%rowtype;
begin
  insert into assistant_demo_usage(user_id, window_start, count)
    values (p_user, now(), 0) on conflict (user_id) do nothing;
  select * into cur from assistant_demo_usage where user_id = p_user for update;
  if now() - cur.window_start > make_interval(secs => p_window_secs) then
    update assistant_demo_usage set window_start = now(), count = 1 where user_id = p_user;
    return true;
  end if;
  if cur.count >= p_limit then
    return false;
  end if;
  update assistant_demo_usage set count = count + 1 where user_id = p_user;
  return true;
end;
$$;
revoke execute on function nopm_demo_rate_check(uuid, int, int) from public, anon, authenticated;
grant execute on function nopm_demo_rate_check(uuid, int, int) to service_role;

-- (2) Harden the four-eyes deletion RPC: pin search_path + drop the default
--     PUBLIC execute grant (only the service-role app should call it). The
--     audit_log INSERT RLS already rolls back a direct authenticated call; this
--     removes the footgun entirely.
alter function nopm_commit_task_deletion(uuid, uuid, text, uuid, text) set search_path = public;
revoke execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant  execute on function nopm_commit_task_deletion(uuid, uuid, text, uuid, text) to service_role;

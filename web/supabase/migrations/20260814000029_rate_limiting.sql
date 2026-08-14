-- NoPM · 0029 — baseline API rate limiting (devops-wave1a, T3-rate-limiter).
-- DB-backed, workspace-keyed, fail-open+audited fixed-window counter so the
-- cap holds across serverless instances / cold starts (mirrors the
-- nopm_demo_rate_check pattern from 20260610000023_security_hardening.sql).
--
-- RLS enabled with ZERO policies = deny-all for anon/authenticated, same
-- pattern as assistant_credentials (20260608000014_assistant_credentials.sql).
-- Only the service-role admin client (bypasses RLS) reads/writes this table.

create table nopm_rate_counters (
  rate_key     text        not null,
  window_start timestamptz not null,
  hits         int         not null default 0,
  primary key (rate_key, window_start)
);

alter table nopm_rate_counters enable row level security;
-- Zero policies: deny-all. Only the service-role admin client accesses this table.
revoke all on nopm_rate_counters from anon, authenticated;

-- Fixed-window counter: row-locked upsert FOR UPDATE, modeled on
-- nopm_demo_rate_check. Returns jsonb { allowed, remaining, retry_after_seconds }
-- rather than a bare boolean since callers need remaining/retry info for the
-- 429 response. Includes opportunistic cleanup of stale windows (older than
-- 2 windows) so the table doesn't grow unbounded without a separate cron job.
create or replace function nopm_rate_check(p_key text, p_max int, p_window_seconds int)
  returns jsonb
  language plpgsql
  set search_path = public
as $$
declare
  cur       nopm_rate_counters%rowtype;
  cur_start timestamptz := date_trunc('second', now())
                            - (extract(epoch from now())::int % p_window_seconds) * interval '1 second';
begin
  -- Opportunistic cleanup: drop windows older than 2 window-widths for this
  -- key so the table stays small without a dedicated cron job.
  delete from nopm_rate_counters
   where rate_key = p_key
     and window_start < cur_start - (2 * p_window_seconds) * interval '1 second';

  insert into nopm_rate_counters(rate_key, window_start, hits)
    values (p_key, cur_start, 0)
    on conflict (rate_key, window_start) do nothing;

  select * into cur
    from nopm_rate_counters
   where rate_key = p_key and window_start = cur_start
   for update;

  if cur.hits >= p_max then
    return jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'retry_after_seconds', greatest(1, p_window_seconds - (extract(epoch from now())::int % p_window_seconds))
    );
  end if;

  update nopm_rate_counters set hits = hits + 1
   where rate_key = p_key and window_start = cur_start;

  return jsonb_build_object(
    'allowed', true,
    'remaining', greatest(0, p_max - (cur.hits + 1)),
    'retry_after_seconds', 0
  );
end;
$$;

revoke execute on function nopm_rate_check(text, int, int) from public, anon, authenticated;
grant  execute on function nopm_rate_check(text, int, int) to service_role;

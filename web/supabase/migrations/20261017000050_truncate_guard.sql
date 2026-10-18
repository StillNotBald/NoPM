-- NoPM · 0050 truncate_guard — audit_log immutability now covers TRUNCATE (section 3 also fixes nopm_rate_check).
--
-- THE GAP. 0006 made audit_log append-only with two ROW triggers
-- (trg_audit_no_update, trg_audit_no_delete). Neither fires for TRUNCATE:
-- Postgres runs row triggers per row, and TRUNCATE touches no rows. So the one
-- statement that erases the whole trail in one go was not covered, and the
-- default Supabase grants hand TRUNCATE (and REFERENCES / TRIGGER) on every
-- public table to anon and authenticated. PostgREST has no TRUNCATE verb, so
-- nothing reachable over HTTP could use it today — but any SQL-capable path (a
-- future RPC, an injected statement, a mis-scoped role) would have bypassed
-- the immutability claim that the Trust Center is built on.
--
-- TWO LAYERS, because either alone is one careless statement from regressing
-- (same reasoning as 0048):
--   1. PRIVILEGES. Revoke TRUNCATE, REFERENCES and TRIGGER on every existing
--      public table from anon and authenticated, and change the default
--      privileges so a table created LATER does not hand them back. The
--      service role keeps its grants (API, RPCs and triggers run as it).
--   2. A statement-level BEFORE TRUNCATE trigger on audit_log. It raises for
--      EVERYONE, including the service role and the table owner, exactly as the
--      two row triggers do. It reuses nopm_audit_immutable() (0006): for a
--      TRUNCATE, tg_op is 'TRUNCATE', so the message reads
--      "audit_log is append-only: TRUNCATE is not permitted". TRUNCATE ...
--      CASCADE from a referenced table (workspaces) fires it too.
--
-- NOT COVERED (stated plainly, not hidden): a superuser or the table owner can
-- still DROP the trigger or run the statement with session_replication_role =
-- replica. immutability.test.ts keeps any MIGRATION from doing that; tamper
-- evidence against a database owner needs an external anchor, which is a
-- separate decision.
--
-- DEFAULT PRIVILEGES apply per creating role. `alter default privileges` without
-- FOR ROLE targets the role running this migration (postgres, the migration
-- runner and the owner of the public tables on Supabase).
--
-- ROLLBACK (do not, unless audited): drop trigger trg_audit_no_truncate on
-- audit_log; then re-grant per table. Re-running this file is safe: every
-- statement is idempotent.

-- ── 1. Privileges ───────────────────────────────────────────────────────────
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;

-- ── 2. The statement-level guard on audit_log ───────────────────────────────
drop trigger if exists trg_audit_no_truncate on audit_log;
create trigger trg_audit_no_truncate before truncate on audit_log
  for each statement execute function nopm_audit_immutable();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. nopm_rate_check — one window per interval, and a table that cannot grow
--    without bound. (Same migration: it ships with the same release.)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE BUG (Lark red-team). 0029 computed the window start as
--     date_trunc('second', now()) - (extract(epoch from now())::int % W) * '1 s'
-- The first term FLOORS to the whole second; the ::int cast ROUNDS to the
-- nearest one. In the second half of every second the two disagree by one, so
-- the start comes out one second early: every window was split across two
-- bucket rows (A and A-1) with separate counters, and a cap of N admitted up to
-- 2N requests per interval (600 requests passed a 300/min cap). The fix is one
-- expression: floor(epoch / W) * W, used for the bucket AND for retry_after.
-- Counters written by the old function live under the old, misaligned starts;
-- they simply age out (nothing reads them under the new alignment).
--
-- THE GROWTH. The old cleanup deleted stale windows only for the SAME key it
-- was called with, so a key that is never seen again (one per attacker-chosen
-- address or id on the pre-auth limiters) left its row forever. Now each row
-- carries expires_at (its window start plus two windows) and EVERY call prunes
-- up to 100 expired rows of any key (indexed, FOR UPDATE SKIP LOCKED so
-- concurrent callers never wait on or deadlock over the same rows). A call adds
-- at most one row and removes up to one hundred, so the table stays within the
-- last two windows' worth of distinct keys. Keys are capped at 256 characters
-- and windows at one hour, so a caller cannot park rows for long either.
--
-- Callers and signature are unchanged: nopm_rate_check(text, int, int) ->
-- jsonb { allowed, remaining, retry_after_seconds }.

alter table nopm_rate_counters add column if not exists expires_at timestamptz not null default (now() + interval '1 day');
create index if not exists nopm_rate_counters_expires_idx on nopm_rate_counters (expires_at);

create or replace function nopm_rate_check(p_key text, p_max int, p_window_seconds int)
  returns jsonb
  language plpgsql
  set search_path = public
as $$
declare
  cur        nopm_rate_counters%rowtype;
  now_epoch  numeric;
  win_epoch  numeric;
  cur_start  timestamptz;
begin
  if p_key is null or length(p_key) > 256 then
    raise exception 'nopm_rate_check: key must be 1-256 characters' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'nopm_rate_check: window must be 1-3600 seconds' using errcode = '22023';
  end if;

  now_epoch := extract(epoch from now())::numeric;
  win_epoch := floor(now_epoch / p_window_seconds) * p_window_seconds;
  cur_start := to_timestamp(win_epoch);

  -- Bounded prune of ANY key's expired windows (see THE GROWTH above).
  delete from nopm_rate_counters
   where ctid = any (array(
     select ctid from nopm_rate_counters
      where expires_at < now()
      order by expires_at
      limit 100
        for update skip locked
   ));

  insert into nopm_rate_counters(rate_key, window_start, hits, expires_at)
    values (p_key, cur_start, 0, cur_start + (2 * p_window_seconds) * interval '1 second')
    on conflict (rate_key, window_start) do nothing;

  select * into cur
    from nopm_rate_counters
   where rate_key = p_key and window_start = cur_start
   for update;

  if cur.hits >= p_max then
    return jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'retry_after_seconds', greatest(1, ceil(p_window_seconds - (now_epoch - win_epoch)))::int
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

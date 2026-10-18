-- NoPM · 0024 realtime_notifications
-- Idempotently add the notifications table to the supabase_realtime publication
-- so that Supabase Realtime broadcasts INSERT / UPDATE events to subscribed clients.
-- The guard prevents errors on re-runs (e.g. CI deploy retries).

do $$ begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'notifications'
  ) then
    alter publication supabase_realtime add table notifications;
  end if;
end $$;

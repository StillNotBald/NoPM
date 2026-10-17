-- NoPM · lark wave rollout · PRE-CHECK  (READ-ONLY: every statement is a SELECT, nothing is written)
--
-- What it does: verifies the live database is exactly where the rollout assumes (ledger at 0001-0044
-- plus 0048, none of the wave's objects present, every object the files alter by name exists), sizes
-- the two statements that take heavy locks, and counts the legacy rows the new constraints and
-- backfills act on. Each row has an "expect" column.
-- When to run: BEFORE applying anything, in the Supabase SQL editor (or psql) as postgres. Paste the
-- whole result into the cutover ticket. The gates per row are in CUTOVER/07-LARK-WAVE-ROLLOUT.md
-- section 2. Run it again after any fix (for example after dedupe-signoffs.sql).

-- A. Ledger state ------------------------------------------------------------
select 'A1 ledger rows' as check_name, count(*)::text as got, '45 (0001-0044 + 0048)' as expect
  from _nopm_migrations
union all
select 'A2 latest ledger names', string_agg(name, ', ' order by name desc), '...0048..., ...0044...'
  from (select name from _nopm_migrations order by name desc limit 3) t
union all
select 'A3 pending files already in ledger?',
       coalesce(string_agg(name, ', '), 'none'), 'none (0045-0047, 0049-0054 must be absent)'
  from _nopm_migrations
 where name ~ '^2026101[67]000(045|046|047|049|050|051|052|053|054)_'
union all
-- B. Objects the new files create must NOT exist yet (a half-applied past attempt would fail them)
select 'B1 hub/calendar tables already present', coalesce(string_agg(t, ', '), 'none'), 'none'
  from unnest(array['integration_connectors','external_identities','identity_link_codes','integration_deliveries',
                    'action_tokens','inbound_actions','calendar_feeds','integration_cron_state']) t
 where to_regclass('public.' || t) is not null
union all
select 'B2 principal/new columns already present',
       coalesce(string_agg(table_name || '.' || column_name, ', '), 'none'), 'none'
  from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in (
     ('deletion_requests','requested_principal_id'), ('deletion_requests','approved_principal_id'),
     ('change_requests','requested_principal_id'),   ('change_requests','decided_principal_id'),
     ('timesheet_submissions','submitted_principal_id'), ('timesheet_submissions','decided_principal_id'),
     ('timesheet_submissions','content_digest'),     ('timesheet_submissions','reopened_at'),
     ('rebaselines','requested_principal_id'),       ('rebaseline_signoffs','approver_principal_id'),
     ('audit_log','via_connector_id'),               ('api_tokens','kind'),
     ('nopm_rate_counters','expires_at'),            ('action_tokens','approval_version'))
union all
-- C. Things the files drop/alter BY NAME must exist (a missing name aborts that file)
select 'C1 audit_channel_check present (0046 drops it by name)',
       (select count(*)::text from pg_constraint where conrelid = 'public.audit_log'::regclass and conname = 'audit_channel_check'),
       '1'
union all
select 'C2 triggers 0045 toggles by name',
       (select count(*)::text from pg_trigger
         where not tgisinternal and tgname in ('trg_change_requests_updated','trg_timesheet_submissions_updated','trg_rebaseline_no_self_signoff')),
       '3'
union all
select 'C3 helper functions present',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('nopm_set_updated_at','nopm_audit_immutable','nopm_rate_check')),
       '3'
union all
select 'C4 commit RPC overloads today (7-arg signatures main calls)',
       (select string_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ')', ' | ')
          from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('nopm_commit_task_deletion','nopm_commit_project_deletion')),
       '2 functions, 7 args each'
union all
select 'C5 API roles exist',
       (select count(*)::text from pg_roles where rolname in ('anon','authenticated','service_role')), '3'
union all
-- D. Size and lock-duration inputs
select 'D1 audit_log rows / size (0046 scans it under ACCESS EXCLUSIVE)',
       (select reltuples::bigint::text || ' rows (est) / ' || pg_size_pretty(pg_total_relation_size('public.audit_log'))
          from pg_class where oid = 'public.audit_log'::regclass),
       'under ~1M rows is a sub-second scan; above that see the lock note in CUTOVER/07-LARK-WAVE-ROLLOUT.md'
union all
select 'D2 audit_log exact count', (select count(*)::text from audit_log), '-'
union all
select 'D3 nopm_rate_counters rows / size (0050 builds an index, blocking writes)',
       (select count(*)::text from nopm_rate_counters) || ' / ' || pg_size_pretty(pg_total_relation_size('public.nopm_rate_counters')),
       'tens of thousands is fine'
union all
select 'D4 long-running transactions (would queue the DDL, and everything behind it)',
       coalesce((select string_agg(pid || ':' || state || ':' || (now() - xact_start)::text, ', ')
                   from pg_stat_activity
                  where datname = current_database() and pid <> pg_backend_pid()
                    and xact_start < now() - interval '30 seconds' and state <> 'idle'), 'none'),
       'none'
union all
-- E. Legacy rows the new constraints / backfills care about
select 'E1 api_tokens with NO creator (not revoked)',
       (select count(*)::text from api_tokens where created_by is null and not revoked),
       'ideally 0; each can never approve anything after 0045 (fail-closed)'
union all
select 'E2 tokens 0052 will mark kind=assistant',
       (select count(*)::text from api_tokens
         where name like 'AI Assistant ' || chr(183) || '%' and expires_at is not null and expires_at <= created_at + interval '61 minutes'),
       'the ephemeral per-turn tokens'
union all
select 'E3 tokens named like the assistant that STAY kind=user (become visible)',
       (select count(*)::text from api_tokens
         where name like 'AI Assistant ' || chr(183) || '%'
           and not (expires_at is not null and expires_at <= created_at + interval '61 minutes')),
       'review each: hand-made or long-lived'
union all
select 'E4 duplicate rebaseline sign-offs (0045 aborts if any: needs uniq_rebaseline_signoff_approver)',
       (select count(*)::text from (select 1 from rebaseline_signoffs group by rebaseline_id, approver_id having count(*) > 1) d),
       '0 (else 0045 aborts by design: review and run dedupe-signoffs.sql first)'
union all
select 'E5 pending deletion requests (in flight during the migrate->deploy window)',
       (select count(*)::text from deletion_requests where status = 'pending'),
       'approve none of these between migration and deploy'
union all
select 'E6 pending PROJECT deletions (0049 snapshots their child counts now)',
       (select count(*)::text from deletion_requests where status = 'pending' and target_type = 'project'),
       'any child added after the migration makes the approval fail loudly'
union all
select 'E7 submitted timesheets (0049 freezes these weeks)',
       (select count(*)::text from timesheet_submissions where status = 'submitted'), '-'
union all
select 'E8 submitted timesheets whose entries already drifted from the snapshot (will be unapprovable)',
       (select count(*)::text from timesheet_submissions s
         where s.status = 'submitted'
           and ((select coalesce(sum(hours), 0) from time_entries e
                  where e.member_id = s.member_id and e.entry_date between s.period_start and s.period_end) <> s.hours_total
             or (select count(*) from time_entries e
                  where e.member_id = s.member_id and e.entry_date between s.period_start and s.period_end) <> s.entry_count)),
       '0 (any hit must be rejected and resubmitted by the member)'
union all
select 'E9 rebaselines by status',
       (select string_agg(status::text || '=' || n, ', ') from (select status, count(*) n from rebaselines group by status order by status) s),
       '-'
union all
-- F. Legacy self-decided history (same HUMAN on both sides, through two identities).
-- 0045 adds the principal CHECKs NOT VALID: these rows are kept, but ANY later UPDATE of one fails 23514.
select 'F1 deletion_requests decided by the same human who raised them',
       (select count(*)::text from (
          select case dr.requested_by_type when 'user' then dr.requested_by_id
                      else (select t.created_by from api_tokens t where t.id = dr.requested_by_id) end rp,
                 case dr.approved_by_type when 'user' then dr.approved_by_id
                      else (select t.created_by from api_tokens t where t.id = dr.approved_by_id) end ap
            from deletion_requests dr where dr.approved_by_id is not null) x
         where rp is not null and rp = ap), '0 is clean; each hit is frozen history'
union all
select 'F2 change_requests decided by the same human who raised them',
       (select count(*)::text from (
          select case cr.requested_by_type when 'user' then cr.requested_by_id
                      else (select t.created_by from api_tokens t where t.id = cr.requested_by_id) end rp,
                 case cr.decided_by_type when 'user' then cr.decided_by_id
                      else (select t.created_by from api_tokens t where t.id = cr.decided_by_id) end dp
            from change_requests cr where cr.decided_by_id is not null) x
         where rp is not null and rp = dp), '0 is clean; each hit is frozen history'
union all
select 'F3 timesheet_submissions decided by the same human who submitted them',
       (select count(*)::text from (
          select case ts.submitted_by_type when 'user' then ts.submitted_by
                      else (select t.created_by from api_tokens t where t.id = ts.submitted_by) end sp,
                 case ts.decided_by_type when 'user' then ts.decided_by
                      else (select t.created_by from api_tokens t where t.id = ts.decided_by) end dp
            from timesheet_submissions ts where ts.decided_by is not null) x
         where sp is not null and sp = dp), '0 is clean; each hit is frozen history'
union all
select 'F4 requests whose requester principal is unknowable (no-creator token)',
       (select count(*)::text from deletion_requests dr
         join api_tokens t on dr.requested_by_type = 'token' and t.id = dr.requested_by_id
        where t.created_by is null), 'those stay approvable by any other human'
order by 1;

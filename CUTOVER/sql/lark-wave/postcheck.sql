-- NoPM · lark wave rollout · POST-CHECK  (READ-ONLY: a single SELECT, nothing is written)
--
-- What it does: asserts the end state of the wave's migrations: all ledger names present, the new
-- tables deny-all (RLS on, no policy, no API-role privilege, service_role can write), the new
-- functions callable only by service_role, one 12-argument copy of each deletion-commit RPC, the
-- columns, constraints, triggers and indexes in place, and the principal backfill complete.
-- Verdict column: ok = matches "expect", CHECK = investigate, info = informational only.
-- When to run: right after the migration commits (BEFORE promoting the new build), and again after the
-- post-window backfill. Any CHECK row: do not promote; see CUTOVER/07-LARK-WAVE-ROLLOUT.md section 7.

with
new_tables(t) as (values ('integration_connectors'),('external_identities'),('identity_link_codes'),
  ('integration_deliveries'),('action_tokens'),('inbound_actions'),('calendar_feeds'),('integration_cron_state')),
new_funcs(sig) as (values
  ('nopm_assert_project_baseline_unlocked()'),('nopm_week_lock_state(uuid,date)'),('nopm_assert_week_unlocked()'),
  ('nopm_assert_timesheet_unchanged()'),('nopm_enforce_rebaseline_lifecycle()'),('nopm_project_child_counts(uuid)'),
  ('nopm_assert_project_children_unchanged()'),('nopm_rate_check(text,integer,integer)'),
  ('nopm_recompute_project_completion(uuid)')),
checks as (
  select 1 n, 'ledger rows' item, (select count(*)::text from _nopm_migrations) got, '54' expect
  union all select 2, 'ledger has all ten names 0045-0054',
    (select count(*)::text from _nopm_migrations where name ~ '^2026101[67]000(045|046|047|048|049|050|051|052|053|054)_'), '10'
  union all select 3, 'new tables exist', (select count(*)::text from new_tables where to_regclass('public.' || t) is not null), '8'
  union all select 4, 'new tables: RLS on',
    (select count(*)::text from new_tables n join pg_class c on c.oid = to_regclass('public.' || n.t) where c.relrowsecurity), '8'
  union all select 5, 'new tables: policies (must be zero = deny-all)',
    (select count(*)::text from pg_policies p join new_tables n on n.t = p.tablename where p.schemaname = 'public'), '0'
  union all select 6, 'new tables: any privilege held by anon or authenticated',
    (select count(*)::text from new_tables n, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      where has_table_privilege('anon', 'public.' || n.t, p) or has_table_privilege('authenticated', 'public.' || n.t, p)), '0'
  union all select 7, 'new tables: service_role can SELECT+INSERT (default ACL check)',
    (select count(*)::text from new_tables n
      where has_table_privilege('service_role', 'public.' || n.t, 'SELECT') and has_table_privilege('service_role', 'public.' || n.t, 'INSERT')), '8'
  union all select 8, 'API roles holding any INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN privilege on a public table (0054)',
    (select coalesce(string_agg(distinct c.relname, ','), 'none') from pg_class c, lateral aclexplode(c.relacl) a
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and a.grantee::regrole::text in ('anon','authenticated')
        and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')),
    'none'
  union all select 9, 'non-select RLS policies left on public tables',
    (select count(*)::text from pg_policies where schemaname = 'public' and cmd <> 'SELECT'), '0'
  union all select 10, 'deletion commit RPC overloads (one each, 12 args)',
    (select string_agg(proname || '/' || pronargs, ',' order by proname) from pg_proc
      where pronamespace = 'public'::regnamespace and proname in ('nopm_commit_task_deletion','nopm_commit_project_deletion')),
    'nopm_commit_project_deletion/12,nopm_commit_task_deletion/12'
  union all select 11, 'new or tightened functions: EXECUTE held by anon / authenticated (incl. recompute_project_completion)',
    (select count(*)::text from new_funcs f
      where has_function_privilege('anon', ('public.' || f.sig)::regprocedure, 'EXECUTE')
         or has_function_privilege('authenticated', ('public.' || f.sig)::regprocedure, 'EXECUTE')), '0'
  union all select 12, 'new or tightened functions: EXECUTE held by service_role',
    (select count(*)::text from new_funcs f where has_function_privilege('service_role', ('public.' || f.sig)::regprocedure, 'EXECUTE')), '9'
  union all select 13, 'principal columns present (11)',
    (select count(*)::text from information_schema.columns where table_schema = 'public' and (table_name, column_name) in (
      ('deletion_requests','requested_principal_id'),('deletion_requests','approved_principal_id'),
      ('change_requests','requested_principal_id'),('change_requests','decided_principal_id'),
      ('timesheet_submissions','submitted_principal_id'),('timesheet_submissions','decided_principal_id'),
      ('rebaselines','requested_principal_id'),('rebaseline_signoffs','approver_principal_id'),
      ('timesheet_submissions','content_digest'),('timesheet_submissions','reopened_at'),('api_tokens','kind'))), '11'
  union all select 14, 'action_tokens + audit_log new columns (5)',
    (select count(*)::text from information_schema.columns where table_schema = 'public' and (table_name, column_name) in (
      ('action_tokens','approval_version'),('action_tokens','superseded_reason'),
      ('audit_log','via_connector_id'),('audit_log','external_event_id'),('audit_log','external_actor_ref'))), '5'
  union all select 15, 'principal CHECKs present, NOT VALID (expected)',
    (select count(*)::text from pg_constraint where conname in ('deletion_principal_distinct','cr_principal_distinct','ts_principal_distinct') and not convalidated), '3'
  union all select 16, 'uniq_rebaseline_signoff_approver exists (0 = index missing; 0045 aborts on duplicates, see finding F-04)',
    (select count(*)::text from pg_indexes where indexname = 'uniq_rebaseline_signoff_approver'), '1'
  union all select 17, 'audit_log channel CHECK allows lark, validated',
    (select count(*)::text from pg_constraint where conname = 'audit_channel_check' and convalidated and pg_get_constraintdef(oid) like '%lark%'), '1'
  union all select 18, 'audit_log TRUNCATE guard present',
    (select count(*)::text from pg_trigger where tgname = 'trg_audit_no_truncate' and not tgisinternal), '1'
  union all select 19, 'audit_log still has both row guards',
    (select count(*)::text from pg_trigger where tgname in ('trg_audit_no_update','trg_audit_no_delete') and not tgisinternal), '2'
  union all select 20, 'lifecycle triggers (6)',
    (select count(*)::text from pg_trigger where not tgisinternal and tgname in (
      'trg_lock_backstop_projects_upd','trg_period_lock_time_entries_upd','trg_timesheet_approval_binds_content',
      'trg_rebaseline_lifecycle','trg_project_delete_scope','trg_rebaseline_no_self_signoff')), '6'
  union all select 21, 'backfill: principal columns still NULL where the actor is a user (must be 0)',
    (select ((select count(*) from deletion_requests where requested_by_type = 'user' and requested_principal_id is null)
           + (select count(*) from change_requests where requested_by_type = 'user' and requested_principal_id is null)
           + (select count(*) from timesheet_submissions where submitted_by_type = 'user' and submitted_principal_id is null))::text), '0'
  union all select 22, 'backfill: token-raised requests whose token HAS a creator but principal is NULL (must be 0)',
    (select ((select count(*) from deletion_requests d join api_tokens t on t.id = d.requested_by_id
               where d.requested_by_type = 'token' and d.requested_principal_id is null and t.created_by is not null)
           + (select count(*) from change_requests c join api_tokens t on t.id = c.requested_by_id
               where c.requested_by_type = 'token' and c.requested_principal_id is null and t.created_by is not null)
           + (select count(*) from timesheet_submissions s join api_tokens t on t.id = s.submitted_by
               where s.submitted_by_type = 'token' and s.submitted_principal_id is null and t.created_by is not null))::text), '0'
  union all select 23, 'pending project deletions all carry the 15-key child_counts snapshot (0054)',
    (select case when n_bad = 0 then 'all' else 'missing ' || n_bad end
       from (select count(*) as n_bad from deletion_requests d
              where d.status = 'pending' and d.target_type = 'project'
                and (not (d.before ? 'child_counts')
                     or (select count(*) from jsonb_object_keys(d.before -> 'child_counts')) <> 15)) x), 'all'
  union all select 24, 'api_tokens by kind',
    (select string_agg(kind || '=' || n, ', ' order by kind) from (select kind, count(*) n from api_tokens group by kind) k), 'user=<n>, assistant=<small>'
  union all select 25, 'nopm_rate_counters.expires_at has no NULLs and the index exists',
    (select (count(*) filter (where expires_at is null))::text || ' nulls / idx=' ||
            (select count(*) from pg_indexes where indexname = 'nopm_rate_counters_expires_idx') from nopm_rate_counters), '0 nulls / idx=1'
  union all select 26, 'nopm_project_child_counts() returns 15 keys (0054)',
    (select count(*)::text from jsonb_object_keys(nopm_project_child_counts('00000000-0000-0000-0000-000000000000'::uuid))), '15'
)
select n, item, got, expect,
       case when item like '%informational%' or item like 'api_tokens by kind%' then 'info'
            when got = expect then 'ok' else 'CHECK' end as verdict
  from checks order by n;

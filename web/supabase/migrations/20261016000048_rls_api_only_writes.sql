-- NoPM · 0048 rls_api_only_writes — the API is the ONLY writer of governed data.
--
-- THE DEFECT. The constitution says every mutation goes through a documented
-- API route that writes exactly one immutable audit_log row, with the scope,
-- lock, period-lock and four-eyes checks that live in route code and RPCs.
-- But the early migrations (0003–0006, 0012, 0015, 0017, 0034, 0035, 0037)
-- also gave every non-viewer a `for all` (or per-command insert/update/delete)
-- RLS policy on the domain tables. A signed-in member already holds the public
-- anon key and their own session JWT in the browser, so they could INSERT /
-- UPDATE / DELETE those rows straight through Supabase's REST endpoint
-- (PostgREST) — no audit row, no maker-checker, no lock / scope / state-machine
-- checks. E.g. PATCH their own change request to status 'approved', or DELETE a
-- task without a deletion request. No NoPM code path ever used those policies:
-- every route handler writes through the service-role admin client.
--
-- THE RULE. The API is the only writer. The service role BYPASSES RLS and keeps
-- its table privileges, so every route, RPC (nopm_commit_*, nopm_apply_*,
-- nopm_accept_invite) and trigger keeps working untouched. Session users keep
-- exactly what the app reads through the session client: the SELECT policies
-- (tenant isolation) are left alone.
--
-- TWO LAYERS, because either alone is one `create policy` away from regressing:
--   1. drop every non-select policy on these tables (RLS denies by default);
--   2. revoke INSERT/UPDATE/DELETE from anon + authenticated (a future
--      careless policy still cannot grant what the role no longer holds).
--
-- TABLES LOCKED (21, all governed domain data):
--   projects, milestones, tasks                                    (0003)
--   resource_members, allocations, time_entries, project_budget,
--     expenses                                                     (0004)
--   risks, issues, clashes                                         (0005)
--   deletion_requests, rebaselines, rebaseline_signoffs            (0006)
--   task_dependencies                                              (0012)
--   documents                                                      (0015)
--   change_requests, decisions                                     (0017)
--   programs                                                       (0034)
--   saved_views — workspace data, every mutation is audited (0035 header)
--   sprints                                                        (0037)
--   timesheet_submissions — already RLS select-only (0038); privileges
--     revoked here as belt and braces, no policy to drop
--
-- DELIBERATELY NOT TOUCHED (see rls-write-lockdown.test.ts for the allow-list):
--   audit_log                        no write policy; immutable by trigger (0006)
--   profiles                         "user updates own profile" (0001)
--   notifications                    "update own notifications" — read state (0007)
--   0046 / 0047 tables, invites, nopm_rate_counters
--                                    already `revoke all` from anon/authenticated
--   user_mfa, api_tokens, assistant_*, user_preferences
--                                    RLS on with zero policies = deny-all
--
-- ROLLBACK (only if a legitimate session-client write path is discovered —
-- prefer routing that write through an audited API route instead). Per table:
--   grant insert, update, delete on <table> to anon, authenticated;
--   create policy "write_<table>" on <table> for all
--     using (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer')
--     with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer');
-- (policy names: "write projects" / "write milestones" / "write tasks" /
-- "write programs" / "write sprints" use a space; the rest use `write_<table>`;
-- saved_views' three per-command policies are in 0035.) Re-running this file is
-- safe: every statement is idempotent.

-- ── 1. Drop the write policies (read policies stay) ─────────────────────────
drop policy if exists "write projects"              on projects;
drop policy if exists "write milestones"            on milestones;
drop policy if exists "write tasks"                 on tasks;

drop policy if exists "write_resource_members"      on resource_members;
drop policy if exists "write_allocations"           on allocations;
drop policy if exists "write_time_entries"          on time_entries;
drop policy if exists "write_project_budget"        on project_budget;
drop policy if exists "write_expenses"              on expenses;

drop policy if exists "write_risks"                 on risks;
drop policy if exists "write_issues"                on issues;
drop policy if exists "write_clashes"               on clashes;

drop policy if exists "write_deletion_requests"     on deletion_requests;
drop policy if exists "write_rebaselines"           on rebaselines;
drop policy if exists "write_rebaseline_signoffs"   on rebaseline_signoffs;

drop policy if exists "write_task_dependencies"     on task_dependencies;
drop policy if exists "write_documents"             on documents;

drop policy if exists "write_change_requests"       on change_requests;
drop policy if exists "write_decisions"             on decisions;

drop policy if exists "write programs"              on programs;

drop policy if exists "insert saved_views"          on saved_views;
drop policy if exists "update saved_views"          on saved_views;
drop policy if exists "delete saved_views"          on saved_views;

drop policy if exists "write sprints"               on sprints;

-- ── 2. Revoke the write privileges (select is kept for the read policies) ───
revoke insert, update, delete on projects              from anon, authenticated;
revoke insert, update, delete on milestones            from anon, authenticated;
revoke insert, update, delete on tasks                 from anon, authenticated;

revoke insert, update, delete on resource_members      from anon, authenticated;
revoke insert, update, delete on allocations           from anon, authenticated;
revoke insert, update, delete on time_entries          from anon, authenticated;
revoke insert, update, delete on project_budget        from anon, authenticated;
revoke insert, update, delete on expenses              from anon, authenticated;

revoke insert, update, delete on risks                 from anon, authenticated;
revoke insert, update, delete on issues                from anon, authenticated;
revoke insert, update, delete on clashes               from anon, authenticated;

revoke insert, update, delete on deletion_requests     from anon, authenticated;
revoke insert, update, delete on rebaselines           from anon, authenticated;
revoke insert, update, delete on rebaseline_signoffs   from anon, authenticated;

revoke insert, update, delete on task_dependencies     from anon, authenticated;
revoke insert, update, delete on documents             from anon, authenticated;

revoke insert, update, delete on change_requests       from anon, authenticated;
revoke insert, update, delete on decisions             from anon, authenticated;

revoke insert, update, delete on programs              from anon, authenticated;
revoke insert, update, delete on saved_views           from anon, authenticated;
revoke insert, update, delete on sprints               from anon, authenticated;
revoke insert, update, delete on timesheet_submissions from anon, authenticated;

-- NoPM · 0054 lifecycle_guards_2 (2026-10-17) — the project-deletion scope guard
-- of 0049 now counts EVERYTHING that cascades from a project, and two privilege
-- gaps are closed (sections 3 and 4 below).
--
-- THE GAP. 0049 (M4/M5) made a project deletion refuse (P0016 CHILDREN_CHANGED)
-- when the project gained records after the request was raised, by comparing
-- nopm_project_child_counts() with the snapshot on the pending request. The
-- function counted 12 child tables. Three more cascade from projects and were
-- NOT counted, so rows added to them between "requested" and "approved" were
-- destroyed unannounced — exactly what the guard exists to stop:
--
--   project_budget   project_id is its primary key (one row per project, 0004)
--   clashes          project_a_id AND project_b_id, both on delete cascade (0005)
--   calendar_feeds   project_id, on delete cascade (0047)
--
-- THIS MIGRATION
--   1. redefines nopm_project_child_counts() with those three keys added (same
--      signature, same attributes as 0049: plpgsql, stable, search_path = public,
--      NOT security definer — only the trigger that calls it is, and it runs
--      with its own search_path; execute stays closed to everyone but
--      service_role);
--   2. re-snapshots the child_counts of every project deletion that is still
--      PENDING. Their stored snapshot has 12 keys, the live function now returns
--      15, and the trigger compares the two jsonb values for equality — without
--      this step every open request would fail children_changed at approval for
--      a reason nobody caused. They are bound to the project's contents as of
--      now, the same compromise 0049 made for the requests it found open;
--   3. closes the missing second privilege layer on nine API-only tables (F-09);
--   4. closes EXECUTE on nopm_recompute_project_completion to anon / authenticated.
--
-- WHAT IT DOES NOT TOUCH. No policy is created or re-created (0048 dropped every
-- write policy and revoked the write grants; nothing here gives them back), no
-- trigger is redefined, and nothing here inserts into the audit trail.
--
-- Re-running this file is safe: `create or replace`, idempotent grants and
-- revokes, and an update that recomputes the same value for the same data.
--
-- Guarded by lifecycle-guards-migration.test.ts, which derives the expected
-- table list from every `references projects ... on delete cascade` in
-- supabase/migrations/*.sql, so the next table that cascades from projects fails
-- the build until it is counted here.

create or replace function nopm_project_child_counts(p_project_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return jsonb_build_object(
    'milestones',      (select count(*) from milestones      where project_id = p_project_id),
    'tasks',           (select count(*) from tasks           where project_id = p_project_id),
    'risks',           (select count(*) from risks           where project_id = p_project_id),
    'issues',          (select count(*) from issues          where project_id = p_project_id),
    'change_requests', (select count(*) from change_requests where project_id = p_project_id),
    'decisions',       (select count(*) from decisions       where project_id = p_project_id),
    'rebaselines',     (select count(*) from rebaselines     where project_id = p_project_id),
    'time_entries',    (select count(*) from time_entries    where project_id = p_project_id),
    'documents',       (select count(*) from documents       where project_id = p_project_id),
    'expenses',        (select count(*) from expenses        where project_id = p_project_id),
    'allocations',     (select count(*) from allocations     where project_id = p_project_id),
    'sprints',         (select count(*) from sprints         where project_id = p_project_id),
    'project_budget',  (select count(*) from project_budget  where project_id = p_project_id),
    'calendar_feeds',  (select count(*) from calendar_feeds  where project_id = p_project_id),
    -- A clash cascades from EITHER project it names.
    'clashes',         (select count(*) from clashes         where project_a_id = p_project_id or project_b_id = p_project_id)
  );
end;
$$;

revoke execute on function nopm_project_child_counts(uuid) from public, anon, authenticated;
grant  execute on function nopm_project_child_counts(uuid) to service_role;

-- Requests already waiting for approval hold the old 12-key snapshot. Replace it
-- (jsonb || overwrites the key) so the trigger compares like with like.
update deletion_requests dr
   set before = coalesce(dr.before, '{}'::jsonb)
                || jsonb_build_object('child_counts', nopm_project_child_counts(dr.target_id))
 where dr.target_type = 'project'
   and dr.status = 'pending';

-- ═══ 3. F-09 — a second privilege layer under the API-only tables ═════════════
--
-- Every table below is written ONLY by the API, on the service-role client
-- (grep of src/ shows no write from the session client or the browser; session
-- clients only read, through the select policies). RLS already denies the write
-- because these tables have no write policy — but Supabase's default privileges
-- still hand INSERT / UPDATE / DELETE to anon and authenticated, so the whole
-- protection was one careless `create policy` away from open. 0048 revoked the
-- write grants on the governed domain tables; these nine were outside its list.
-- audit_log keeps its append-only triggers (0006 / 0050); this makes the
-- privilege layer agree with them.
--
-- The service role is unaffected (it keeps its grants and bypasses RLS), so the
-- API, the RPCs and the triggers behave exactly as before.
revoke insert, update, delete on
  api_tokens,
  assistant_conversations,
  assistant_credentials,
  assistant_demo_usage,
  assistant_messages,
  audit_log,
  user_mfa,
  user_preferences,
  workspaces
  from anon, authenticated;

-- PostgreSQL 17 added a MAINTAIN privilege (VACUUM, ANALYZE, REINDEX, CLUSTER,
-- REFRESH MATERIALIZED VIEW, LOCK TABLE). Supabase's default privileges grant ALL
-- on public tables to anon and authenticated, and on 17 that includes MAINTAIN
-- (both roles hold it on every existing table, and the default ACL hands it to
-- every new one). 0050 closed TRUNCATE / REFERENCES / TRIGGER for the same
-- reason: a client role has no business holding it. Nothing in the repo grants
-- it back. Guarded by version because earlier servers reject the unknown
-- privilege name.
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on all tables in schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke maintain on tables from anon, authenticated';
  end if;
end $$;

-- ═══ 4. EXECUTE on the completion rollup is service-role only ═════════════════
--
-- nopm_recompute_project_completion(uuid) (0021) rewrites projects.completion_pct
-- and was left with Postgres's default EXECUTE-to-PUBLIC (plus Supabase's
-- explicit anon / authenticated grants), so it was callable over PostgREST's
-- /rpc. The caller's table privileges stop the UPDATE today (0048), which makes
-- this belt-and-braces, but a function that rewrites a governed column should
-- not be reachable by client roles at all. It is only ever invoked by the task
-- completion triggers (0021 / 0031), which run as the role doing the task write —
-- the service role (API, RPCs) or the owner (migrations, seeds) — and no src/
-- code calls it as anon or authenticated. Not redefined here (the rollup guard
-- test forbids it): only its grants change.
revoke execute on function nopm_recompute_project_completion(uuid) from public, anon, authenticated;
grant  execute on function nopm_recompute_project_completion(uuid) to service_role;

-- NoPM · 0030 — workspace_id indexes for the tables token-actor callers filter
-- by (PATs bypass RLS via the admin client, so every route.ts wraps its
-- Supabase query with `.eq('workspace_id', actor.workspaceId)` — see
-- CLAUDE.md "Scoped Bearer PATs"). Those queries were doing a seq scan on
-- workspace_id for every one of these tables; this migration adds the
-- missing indexes so they hit an index scan instead.
--
-- Plain CREATE INDEX (not CONCURRENTLY): scripts/apply-migrations.mjs wraps
-- every migration file in one `begin ... commit` transaction (see the
-- `client.query("begin")` / `client.query(sql)` / `client.query("commit")`
-- sequence there), and CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block — Postgres would reject it outright. At current table
-- volume (a portfolio demo project, not a production fleet) a plain
-- CREATE INDEX takes single-digit milliseconds and holds a brief
-- SHARE lock, which is a non-issue here. A large/production install
-- applying this migration against a live, heavily-written table should
-- instead apply the equivalent CREATE INDEX CONCURRENTLY statements
-- manually, outside this runner, one at a time; CUTOVER/deploy.md
-- references this comment for that guidance.
--
-- IF NOT EXISTS throughout so a partial/re-run apply is a no-op rather
-- than an error.

-- ── workspace_id — single-column, one per table that lacked it ────────────
-- (Existing indexes already covered: audit_log(workspace_id, created_at desc)
-- from 0006, clashes(workspace_id) from 0005 — both left untouched.)

create index if not exists idx_milestones_workspace_id          on milestones(workspace_id);
create index if not exists idx_tasks_workspace_id                on tasks(workspace_id);
create index if not exists idx_allocations_workspace_id          on allocations(workspace_id);
create index if not exists idx_time_entries_workspace_id         on time_entries(workspace_id);
create index if not exists idx_expenses_workspace_id             on expenses(workspace_id);
create index if not exists idx_risks_workspace_id                on risks(workspace_id);
create index if not exists idx_issues_workspace_id               on issues(workspace_id);
create index if not exists idx_rebaselines_workspace_id          on rebaselines(workspace_id);
create index if not exists idx_rebaseline_signoffs_workspace_id  on rebaseline_signoffs(workspace_id);

-- project_budget is deliberately excluded: project_id IS its primary key
-- (one row per project, 1:1 — see 0004 `project_budget (project_id uuid
-- primary key references projects(id) ...)`), so every lookup is already a
-- PK point-lookup and workspace_id is only ever used there for the RLS/
-- token-scope filter on top of that PK, not as the driving predicate. A
-- workspace_id index would duplicate the PK's selectivity for no gain.

-- ── notifications — composite, mirrors audit_log's shape (0006 line 17) ───
-- The notification center/My Work hub lists a recipient's/workspace's
-- notifications ordered by recency; this composite serves both the
-- workspace_id filter and the created_at desc ordering in one index scan.
create index if not exists idx_notifications_workspace_created
  on notifications(workspace_id, created_at desc);

-- ── tasks — additional hot-filter columns ──────────────────────────────────
-- status_type: board/list filters, "My Work"; assignee_id: My Tasks /
-- capacity views; due_date: date-range queries (calendar, overdue rollups).
create index if not exists idx_tasks_status_type   on tasks(status_type);
create index if not exists idx_tasks_assignee_id    on tasks(assignee_id);
create index if not exists idx_tasks_due_date       on tasks(due_date);

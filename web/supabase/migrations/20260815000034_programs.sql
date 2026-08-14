-- NoPM · 0034 programs — first-class program entity grouping projects (L-01/02/03).
--
-- A program is a named, ownable container above individual projects — the
-- portfolio's answer to "which projects belong to the same initiative",
-- replacing the free-text `projects.program` label with a real, queryable
-- entity that carries its own owner and health.
--
-- Identity model (mirrors migration 0019's correction, NOT projects' own
-- owner_id, which still points at profiles(id) and predates 0019):
--   programs.owner_id -> resource_members(id) — the costed, capacity-bearing
--   person, same target as tasks.assignee_id since 0019. A resource_member
--   optionally bridges to a login via resource_members.profile_id. Programs
--   are built on the CORRECTED identity model from day one rather than
--   inheriting projects.owner_id's pre-0019 profiles(id) target — see the
--   worker's sprint-log report for the explicit call-out of this divergence.
--
-- rag_status reuses the shared `rag_status` enum (0001) — same domain as
-- projects.rag_status. Per L-02 this is a DECLARED value the program owner
-- sets directly via PATCH; it is never overwritten by a rollup computed from
-- child projects (that computation is read-side only — see
-- src/lib/insight/program-rollup.ts's computeChildRag — and is displayed
-- ALONGSIDE this column, never in place of it).
--
-- Legacy projects.program (free text) is KEPT, deprecated, never dropped —
-- existing reads of that column keep working unchanged.

create table programs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  code         text,
  name         text not null,
  description  text,
  owner_id     uuid references resource_members(id) on delete set null,
  rag_status   rag_status not null default 'not_started',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on programs(workspace_id);
create trigger trg_programs_updated before update on programs
  for each row execute function nopm_set_updated_at();

-- A project belongs to 0..1 program. ON DELETE SET NULL — deleting a program
-- NEVER deletes or orphans its child projects; they simply lose the grouping
-- (see DELETE /api/programs/[id]'s docstring: program deletion is a plain
-- single-step hard delete, never routed through deletion_requests — the
-- four-eyes maker-checker flow stays PROJECTS ONLY per Decision 3).
alter table projects
  add column program_id uuid references programs(id) on delete set null;
create index on projects(program_id);

comment on column projects.program is
  'DEPRECATED (0034): legacy free-text program label. Superseded by program_id -> programs(id). Kept for backward compatibility — never dropped.';

-- ── RLS: workspace-scoped; viewers read-only, others read+write ────────────
-- Mirrors projects' pattern exactly (migration 0003).
alter table programs enable row level security;

create policy "read programs"  on programs for select using (workspace_id = nopm_current_workspace());
create policy "write programs" on programs for all
  using (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer')
  with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer');

-- ── Backfill ─────────────────────────────────────────────────────────────
--
-- Reviewed in src/lib/insight/program-backfill-review.test.ts, which asserts
-- this SQL's shape (create-then-link, per-workspace scoping, slugified code,
-- legacy column preserved) stays intact — that test is the "reviewed" record
-- the task spec asks for, not just this comment.
--
-- For each workspace, create ONE program per distinct non-null/non-blank
-- projects.program text value, then point matching projects at it via
-- program_id:
--   1. INSERT one programs row per (workspace_id, distinct program text).
--      code = slugified text (lowercase, non-alnum runs collapsed to a
--      single '-', leading/trailing '-' trimmed, capped at 32 chars to match
--      the code column's zod convention elsewhere in the app — the DB column
--      itself is unconstrained text so a truncated/colliding slug never
--      fails the insert). name = the original text, byte-for-byte.
--   2. UPDATE projects.program_id to the matching program's id, joined on
--      (workspace_id, program = programs.name) — so a project's program_id
--      always points at the program literally named after its legacy text.
--
-- Idempotency: this backfill is designed to run EXACTLY ONCE, immediately
-- after this migration applies — the same expectation migration 0019's
-- backfill carries. A second full re-run would re-INSERT a program per
-- distinct (workspace_id, program) pair a second time (no unique constraint
-- on (workspace_id, name) guards against that) and therefore duplicate
-- programs; the migration runner in this repo does not re-apply already-
-- applied migrations, so that is not a live risk in normal operation.
do $$
begin
  insert into programs (workspace_id, code, name)
  select
    p.workspace_id,
    nullif(
      substring(
        trim(both '-' from regexp_replace(lower(trim(p.program)), '[^a-z0-9]+', '-', 'g'))
        from 1 for 32
      ),
      ''
    ) as code,
    p.program as name
  from (
    select distinct workspace_id, program
    from projects
    where program is not null and trim(program) <> ''
  ) p;

  update projects pr
  set program_id = pg.id
  from programs pg
  where pr.program = pg.name
    and pr.workspace_id = pg.workspace_id
    and pr.program is not null
    and trim(pr.program) <> '';
end $$;

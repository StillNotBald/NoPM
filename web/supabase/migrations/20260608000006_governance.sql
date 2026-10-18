-- NoPM · 0006 governance — immutable audit log, maker-checker, rebaseline sign-off.

-- ── Audit log (append-only) ────────────────────────────────────────────────
create table audit_log (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_type   actor_type not null,
  actor_id     uuid,
  actor_label  text not null,
  action       text not null,            -- verb.noun, e.g. 'task.create', 'task.delete'
  target_type  text not null,
  target_id    uuid,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);
create index on audit_log(workspace_id, created_at desc);
create index on audit_log(target_type, target_id);

-- Immutability: block UPDATE/DELETE for EVERYONE (incl. service_role).
-- This is the governance showpiece — a written audit row can never be altered.
create or replace function nopm_audit_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op;
end $$;
create trigger trg_audit_no_update before update on audit_log
  for each row execute function nopm_audit_immutable();
create trigger trg_audit_no_delete before delete on audit_log
  for each row execute function nopm_audit_immutable();

alter table audit_log enable row level security;
-- Members READ their workspace trail (Trust Center). Inserts happen via the
-- service-role admin client (bypasses RLS); no insert/update/delete policy exists.
create policy "read audit" on audit_log
  for select using (workspace_id = nopm_current_workspace());

-- ── Maker-checker: deletion requests (four-eyes on destructive ops) ────────
create type deletion_status as enum ('pending', 'approved', 'rejected', 'committed');

create table deletion_requests (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  target_type        text not null,           -- e.g. 'task'
  target_id          uuid not null,
  reason             text,
  status             deletion_status not null default 'pending',
  requested_by_type  actor_type not null,
  requested_by_id    uuid not null,
  requested_by_label text not null,
  approved_by_type   actor_type,
  approved_by_id     uuid,
  approved_by_label  text,
  before             jsonb,                    -- snapshot of the target at request time
  decided_at         timestamptz,
  committed_at       timestamptz,
  created_at         timestamptz not null default now(),
  -- Four-eyes: any decided request must carry an approver that differs from the requester.
  constraint maker_checker_different check (
    status = 'pending'
    or (approved_by_id is not null and approved_by_id <> requested_by_id)
  )
);
create index on deletion_requests(workspace_id, status);
-- At most one open request per target.
create unique index uniq_pending_deletion
  on deletion_requests(target_type, target_id) where status = 'pending';

-- ── Control-Tower: rebaseline maker-checker (timeline governance) ──────────
create type rebaseline_status as enum ('draft', 'pending_approval', 'approved', 'applied', 'rejected');
create type vote_choice       as enum ('pending', 'go', 'no_go');

create table rebaselines (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  version      int not null default 1,
  status       rebaseline_status not null default 'draft',
  reason       text,
  requested_by uuid references profiles(id),
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now(),
  applied_at   timestamptz
);
create index on rebaselines(project_id);
create unique index uniq_pending_rebaseline
  on rebaselines(project_id) where status = 'pending_approval';

create table rebaseline_signoffs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  rebaseline_id   uuid not null references rebaselines(id) on delete cascade,
  approver_id     uuid not null references profiles(id),
  vote            vote_choice not null default 'pending',
  voted_at        timestamptz,
  proxy_for       boolean not null default false,
  cast_by         uuid references profiles(id),
  comment         text
);
create index on rebaseline_signoffs(rebaseline_id);

-- ── RLS for the writable governance tables ─────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['deletion_requests','rebaselines','rebaseline_signoffs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy "read_%1$s" on %1$I for select using (workspace_id = nopm_current_workspace())', t);
    execute format(
      'create policy "write_%1$s" on %1$I for all '
      'using (workspace_id = nopm_current_workspace() and nopm_current_role() <> ''viewer'') '
      'with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> ''viewer'')', t);
  end loop;
end $$;

-- NoPM · 0015 documents — workspace-level and project-level governance documents.
-- Covers: charters, plans, RAID logs, status reports, change requests, minutes, specs, etc.
-- reference_id is app-assigned (DOC-NNN); version bumps on body change (API layer).

create table documents (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id   uuid references projects(id) on delete cascade,        -- nullable: workspace-level docs allowed
  reference_id text,                                                   -- e.g. DOC-001 (set by seed/app)
  folder       text not null default 'General',                       -- e.g. Charter, RAID, Status Reports, Change Control, Minutes
  title        text not null,
  doc_type     text not null,                                         -- charter|plan|raid|status_report|change_request|minutes|spec|other
  status       text not null default 'draft',                         -- draft|in_review|approved|archived
  version      int  not null default 1,
  summary      text,
  body         text,                                                   -- markdown content (nullable)
  external_url text,                                                   -- link to an external/generated artifact (nullable)
  owner_id     uuid references profiles(id),
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index on documents(workspace_id, folder);
create index on documents(project_id);

create trigger trg_documents_updated before update on documents
  for each row execute function nopm_set_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table documents enable row level security;

create policy "read_documents" on documents
  for select using (workspace_id = nopm_current_workspace());

create policy "write_documents" on documents
  for all
  using  (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer')
  with check (workspace_id = nopm_current_workspace() and nopm_current_role() <> 'viewer');

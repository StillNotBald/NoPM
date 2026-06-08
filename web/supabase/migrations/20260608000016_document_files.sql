-- NoPM · 0016 document_files — attach a single binary file to any document.
-- Bytes live in a private Supabase Storage bucket; only short-lived signed URLs
-- leave our compute.  Access flows through the governed REST API (workspace-
-- checked + audited); service-role admin client bypasses Storage RLS so no
-- storage policies are needed.

-- ── Columns ────────────────────────────────────────────────────────────────
alter table documents
  add column if not exists storage_path text,
  add column if not exists file_name    text,
  add column if not exists mime_type    text,
  add column if not exists file_size    bigint;

-- ── Private bucket (idempotent) ────────────────────────────────────────────
-- 26 214 400 bytes = 25 MiB cap.  public = false keeps the bucket private.
-- Service-role key mints all signed URLs server-side; no storage RLS needed.
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 26214400)
on conflict (id) do nothing;

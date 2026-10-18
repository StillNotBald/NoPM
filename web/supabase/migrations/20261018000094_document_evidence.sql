-- NoPM · 0094 document evidence (R-137, audit item M4).
-- A document can be attached to ONE change request as test / UAT / deploy evidence.
-- A document is "evidence" only when change_request_id is set; every column is nullable
-- and nothing is backfilled, so no existing row changes and the documents updated_at
-- trigger (trg_documents_updated) is never touched or paused here.
-- ON DELETE SET NULL: deleting a change request keeps the file, it just stops being evidence.

alter table documents
  add column if not exists change_request_id uuid references change_requests(id) on delete set null,
  add column if not exists evidence_type     text,
  add column if not exists evidence_result   text,
  add column if not exists tested_by_label   text,
  add column if not exists tested_at         timestamptz,
  add column if not exists evidence_note     text;

create index if not exists documents_change_request_idx
  on documents (change_request_id)
  where change_request_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'documents_evidence_type_check') then
    alter table documents add constraint documents_evidence_type_check
      check (evidence_type is null
             or evidence_type in ('test_result', 'uat_signoff', 'deploy_record', 'screenshot', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'documents_evidence_result_check') then
    alter table documents add constraint documents_evidence_result_check
      check (evidence_result is null
             or evidence_result in ('pass', 'fail', 'partial', 'n/a'));
  end if;
  -- A result without a type says nothing about what was tested.
  if not exists (select 1 from pg_constraint where conname = 'documents_evidence_result_needs_type') then
    alter table documents add constraint documents_evidence_result_needs_type
      check (evidence_result is null or evidence_type is not null);
  end if;
end $$;

comment on column documents.change_request_id is 'Change request this document is evidence for; null = ordinary document.';
comment on column documents.evidence_type is 'test_result | uat_signoff | deploy_record | screenshot | other';
comment on column documents.evidence_result is 'pass | fail | partial | n/a; requires evidence_type';

-- W2-07: whenever the link goes away (API unlink, or ON DELETE SET NULL when the change
-- request is deleted) the evidence fields go with it, so the rule "evidence only when linked"
-- holds in the database and not only in the API. No backfill: existing rows are untouched.
create or replace function documents_clear_evidence_on_unlink() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.change_request_id is null then
    new.evidence_type     := null;
    new.evidence_result   := null;
    new.tested_by_label   := null;
    new.tested_at         := null;
    new.evidence_note     := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_documents_clear_evidence on documents;
create trigger trg_documents_clear_evidence
  before update of change_request_id on documents
  for each row execute function documents_clear_evidence_on_unlink();

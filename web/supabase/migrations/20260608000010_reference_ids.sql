-- NoPM · 0010 reference_ids — human-readable IDs for risks, issues, clashes.
-- R-001, ISS-001, CL-001 — per-workspace sequential, zero-padded to 3 digits.
-- Column is NULLABLE so existing rows are unaffected; new rows get a value from
-- the API layer (nextRefId helper) before insert.

alter table risks   add column if not exists reference_id text;
alter table issues  add column if not exists reference_id text;
alter table clashes add column if not exists reference_id text;

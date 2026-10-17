-- NoPM · 0071 audit_principal (A3-12 / A3-11).
--
-- Every audit row names the HUMAN behind the actor. `actor_id` is the session
-- user or the PAT id; for a token, the person is only in api_tokens.created_by,
-- which a reader would have to join (and which is gone if the token is deleted).
-- `principal_id` records it on the row itself, filled by writeAudit
-- (src/lib/audit/write.ts) from Actor.principalId: the session user, the PAT's
-- creator, or the verified linked profile of a connector action.
--
-- Strictly additive: a nullable column, no default, no constraint, no backfill.
-- Rows written by SQL RPCs (nopm_commit_*_deletion, nopm_unlock_project,
-- nopm_accept_invite, ...) and all pre-existing rows stay NULL until those RPCs
-- are recreated to set it. There is deliberately no foreign key: the audit
-- trail must outlive a deleted profile.
--
-- audit_log stays insert-only. The immutability triggers (BEFORE UPDATE /
-- DELETE / TRUNCATE) are row/statement triggers and are not touched by adding
-- a column; nothing here drops, disables or replaces them.

alter table audit_log add column if not exists principal_id uuid;

comment on column audit_log.principal_id is
  'the human (profiles.id) behind the actor: session user, PAT creator or linked connector profile; null for system actors, legacy tokens and rows written by SQL RPCs';

create index if not exists audit_log_principal_idx
  on audit_log (workspace_id, principal_id, created_at desc)
  where principal_id is not null;

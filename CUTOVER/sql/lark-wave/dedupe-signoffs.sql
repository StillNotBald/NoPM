-- NoPM · lark wave rollout · DEDUPLICATE REBASELINE SIGN-OFFS  (WRITES; rolls back unless you change the last line)
--
-- What it does: migration 0045 creates a unique index on rebaseline_signoffs (rebaseline_id,
-- approver_id) and ABORTS, applying nothing, if duplicate pairs exist (pre-check row E4 counts them).
-- This script shows the duplicate rows, keeps the NEWEST vote per (rebaseline_id, approver_id), deletes
-- the older ones, and records one audit_log row per deleted sign-off that holds the full deleted row,
-- so the removal is traceable. It does not create the index; 0045 does.
-- Review: step 1 lists every row that would be deleted; read it before committing. The delete is a
-- governance-data change, so it is the owner's decision.
-- When to run: only when pre-check E4 is greater than 0, before applying the migrations. It ends with
-- ROLLBACK so a first run is a dry run; replace the last line with COMMIT to keep the result, then run
-- the pre-check again (E4 must read 0).

begin;

-- 1. Preview: every sign-off that will be deleted, with the vote that survives.
select s.id as to_delete, s.rebaseline_id, s.approver_id, s.vote as old_vote, s.voted_at as old_voted_at,
       k.id as kept, k.vote as kept_vote, k.voted_at as kept_voted_at
  from rebaseline_signoffs s
  join rebaseline_signoffs k
    on k.rebaseline_id = s.rebaseline_id and k.approver_id = s.approver_id
   and (coalesce(k.voted_at, '-infinity'::timestamptz), k.id) > (coalesce(s.voted_at, '-infinity'::timestamptz), s.id)
 order by s.rebaseline_id, s.approver_id, s.voted_at;

-- 2. Delete the older duplicates and audit each deletion (one audit row per deleted sign-off).
with removed as (
  delete from rebaseline_signoffs s
   using rebaseline_signoffs k
   where s.rebaseline_id = k.rebaseline_id and s.approver_id = k.approver_id
     and (coalesce(s.voted_at, '-infinity'::timestamptz), s.id) < (coalesce(k.voted_at, '-infinity'::timestamptz), k.id)
  returning s.*
)
insert into audit_log (workspace_id, actor_type, actor_label, action, target_type, target_id, before, after)
select r.workspace_id, 'user', 'rollout operator (duplicate sign-off cleanup)', 'rebaseline_signoff.dedupe',
       'rebaseline_signoff', r.id, to_jsonb(r), null
  from removed r;

-- 3. Verify: must be 0 rows.
select rebaseline_id, approver_id, count(*) as still_duplicated
  from rebaseline_signoffs
 group by rebaseline_id, approver_id
having count(*) > 1;

-- Replace the next line with COMMIT; once the preview in step 1 looks right.
rollback;

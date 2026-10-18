-- NoPM · 0077 (2026-10-17) — one-off clean-up: cancel orphan DRAFT rebaselines (Q-GOV-4).
--
-- WHY. A rebaseline proposed on an UNLOCKED project used to be stored as a
-- 'draft' (no governed flow applies yet). Q-GOV-4 (common-pattern answer): a
-- rebaseline can only be proposed on a locked project, so a draft is no longer a
-- thing the product creates. The drafts that already exist can never be signed
-- off or applied (their project was unlocked when they were proposed); they only
-- clutter the Baselines list. This migration closes them, once.
--
-- WHAT. Every rebaseline still in 'draft' becomes 'cancelled', with ONE audit row
-- each (action 'rebaseline.cancelled', after.reason = 'orphan_draft_cleanup').
-- The 0049 lifecycle trigger does not allow draft -> cancelled (only the unlock
-- path cancels, from pending_approval / approved), so the trigger is disabled for
-- the duration of this statement block and re-enabled before the migration ends;
-- both happen inside the migration's transaction, so a failure restores it.
-- Idempotent: a second run finds no drafts.
--
-- RUN IT ONLY THROUGH scripts/migrate.mjs (it wraps the file in a transaction). Pasted into a
-- non-transactional console, a failure would leave the trigger disabled.
--
-- ROLLBACK. Not reversible by design (a cancelled draft carried no sign-off); the
-- audit rows name every rebaseline that was closed.

alter table rebaselines disable trigger trg_rebaseline_lifecycle;

with closed as (
  update rebaselines
     set status = 'cancelled'
   where status::text = 'draft'
  returning id, workspace_id, project_id, version
)
insert into audit_log (workspace_id, actor_type, actor_id, actor_label, action, target_type, target_id, before, after)
  select workspace_id, 'user'::actor_type, null, 'system (migration 0077)',
         'rebaseline.cancelled', 'rebaseline', id,
         jsonb_build_object('id', id, 'project_id', project_id, 'version', version, 'status', 'draft'),
         jsonb_build_object('id', id, 'project_id', project_id, 'version', version, 'status', 'cancelled',
                            'reason', 'orphan_draft_cleanup')
    from closed;

alter table rebaselines enable trigger trg_rebaseline_lifecycle;

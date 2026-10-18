# RTM rows - cycle 2 builder C: emergency flag in the UI and reports (Q1), GitHub never completes a task (Q7)

## REQUIREMENTS.md bullets

- **R-159** Emergency flag visible everywhere (owner decision Q1, supersedes UAT-034). An emergency change request commits when raised, needs no approver and no retro, and is only flagged. Acceptance: (a) the Change Control list shows a red "Emergency" badge beside the status for a request whose `is_emergency` is true or whose `tier` is `emergency`, at 390 px and on desktop, and no row says "overdue" because of a retro; (b) the change detail shows the same badge and the line "Emergency change: committed without approval on <raised date> by <raiser>", and offers no Approve, Reject or Defer controls on an emergency request; (c) the raise form's Emergency tick reads "Emergency: commit now, no approval" with the helper "The change commits immediately with no approver and is flagged as an emergency in every report."; (d) the review queue shows a red Emergency badge on an emergency item and no decide-by date; the Approvals page no longer renders a retro-review date or a "retro approval overdue" badge; (e) the weekly report (HTML, stored report), the in-app weekly notification and the Lark weekly card carry "Emergency changes this week: N" with up to ten references and titles (last 7 days, this workspace only); the "overdue for approval" line is gone everywhere; (f) the audit pack change-request sheet keeps its headers: `is_emergency` (`yes` or blank) and a deprecated `retro_overdue` that is always blank for this release; `retro_due_at`, `retro_decided_at`, `retro_outcome` stay as history for rows raised before the retro was retired. Outcome: easier reporting. — **DONE**
- **R-160** GitHub events never complete a task (owner decision Q7: "only manual completed is sufficient"). Acceptance: (a) `completed` is not a work-event rule target: `RULE_TARGETS` lists unstarted, started, in_review, canceled; (b) the default mapping is `pr_opened` started, `pr_merged` in review, `pr_closed` none, `deploy_success` none, `deploy_failure` none; (c) `PATCH /api/integrations/github/connector` answers 422 with "A work event cannot complete a task. Completing a task is a human action; ..." when any rule is `completed`; (d) a stored `completed` (a workspace saved before this change, notably `deploy_success: completed`) is read as none by the code until migration 0106 rewrites it, so a deployment event is recorded as `no_rule` and the task is not touched; (e) the GitHub card status selects no longer offer Completed and show one helper line saying only a person marks a task Completed; (f) the database check function for `work_event_rules` rejects `completed` (SQL below, to be appended to 0106). Outcome: easier reporting. — **DONE** (database half appended to migration 0106 by builder B; `github-migration.test.ts` asserts the rewrite, the new default and the check)

## TRACEABILITY.md rows

| R-159 | Emergency flag visible everywhere (flag only, no approval) | DONE | `web/src/components/change-control/change-table.tsx`, `web/src/components/change-control/change-detail.tsx`, `web/src/components/change-control/change-form.tsx`, `web/src/app/(console)/change-control/page.tsx`, `web/src/app/(console)/approvals/page.tsx`, `web/src/components/review/queue-list.tsx`, `web/src/lib/integrations/digest-data.ts`, `web/src/lib/integrations/types.ts`, `web/src/lib/integrations/lark/cards.ts`, `web/src/lib/nudges/weekly-report.ts`, `web/src/lib/reports/weekly-html.ts`, `web/src/lib/export/audit-pack.ts` | `web/src/components/change-control/emergency-flag.test.ts`, `web/src/app/api/export/audit-pack.test.ts` |
| R-160 | GitHub events never complete a task | DONE | `web/supabase/migrations/20261018000106_tier_decisions.sql`, `web/src/lib/integrations/github/rules.ts`, `web/src/components/integrations/github-card.tsx` | `web/src/lib/integrations/github/github.test.ts`, `web/src/lib/integrations/github/github-migration.test.ts`, `web/src/app/api/integrations/github/github-routes.test.ts`, `web/src/components/integrations/github-card.test.ts` |

## For builder B / migration 0106

Append this block to `web/supabase/migrations/20261018000106_tier_decisions.sql` (or a later file). Order matters: rewrite stored rules first, then the default, then the check function. It is idempotent and cannot fail on live data, because every stored `completed` is turned into JSON null (an event that never moves a task) before the stricter check exists.

```sql
-- R-160 (owner decision Q7): no work event may complete a task; completion is a human action.
-- 1. Rewrite any stored rule that says "completed" to null (never moves a task). Live rows saved with the
--    old default have deploy_success = "completed".
update workspaces w
set work_event_rules = (
  select coalesce(jsonb_object_agg(e.key, case when e.value = '"completed"'::jsonb then 'null'::jsonb else e.value end), '{}'::jsonb)
  from jsonb_each(w.work_event_rules) e
)
where exists (select 1 from jsonb_each(w.work_event_rules) e where e.value = '"completed"'::jsonb);

-- 2. New workspaces default: a deployment no longer completes a task.
alter table workspaces
  alter column work_event_rules set default
    '{"pr_opened": "started", "pr_merged": "in_review", "pr_closed": null, "deploy_success": null, "deploy_failure": null}'::jsonb;

-- 3. The check function no longer accepts "completed" (the CHECK constraint on workspaces already points at it).
create or replace function nopm_valid_work_event_rules(r jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when r is null or jsonb_typeof(r) <> 'object' then false
    else
      not exists (
        select 1 from jsonb_object_keys(r) k
        where k not in ('pr_opened', 'pr_merged', 'pr_closed', 'deploy_success', 'deploy_failure')
      )
      and not exists (
        select 1 from jsonb_each(r) e
        where jsonb_typeof(e.value) <> 'null'
          and not (
            jsonb_typeof(e.value) = 'string'
            and (e.value #>> '{}') in ('unstarted', 'started', 'in_review', 'canceled')
          )
      )
  end
$$;
```

Check before applying: the `update` in step 1 touches `workspaces`. If a trigger on `workspaces` writes audit rows or blocks updates, run step 1 under the same mechanism 0106 already uses for system rewrites. Step 1 changes one JSON column only.

Existing-row behaviour until 0106 is applied: the code reads a stored `completed` as none (see `normalizeRules` in `web/src/lib/integrations/github/rules.ts`), so a live workspace whose stored rule says `deploy_success: completed` already stops completing tasks with this build. The rules shown in `GET /api/integrations/github/connector` show it as null.

## Not done, and why

- `web/src/lib/integrations/github/github-migration.test.ts` is unchanged on purpose. It reads migration 0105, which is history and still says `completed`. A drift test for the new check belongs with 0106 once the SQL above is in it: assert the file contains `'unstarted', 'started', 'in_review', 'canceled'` and does not contain `'completed'` inside `nopm_valid_work_event_rules`.
- `web/src/lib/review/gather.ts` and `web/src/lib/review/pending.ts` (not in my ownership) still compute a retro-based `deadline` and a "waiting emergency" query (`status.implemented, is_emergency, retro_decided_at is null`). With 0106 setting `retro_decided_at` on every emergency these resolve to nothing, and the queue row hides the decide-by date for an emergency regardless. Builder B can delete that code.
- `web/src/lib/integrations/digest-data.ts`, `types.ts`, `lark/cards.ts` and `web/src/lib/nudges/weekly-report.ts` are outside the ownership list but are the only place the weekly report's overdue line was built; they were edited minimally (the `retroOverdue` field became `emergencyChanges`). `web/src/lib/governance/timers.ts` still carries its own `retroOverdue` counter (builder B's file).
- `web/src/components/integrations/approval-policy-card.tsx` still shows the "retro window" hours field with the hint "How long an emergency change may stay live before its approval is overdue." That is a workspace setting in builder B's contract, so it is untouched here; remove or reword it once B retires `emergency_retro_hours`.

## Fields I rely on from builder B's contract

`is_emergency` and `tier` on every change-request payload (list, detail, review item). `raised_at` and `requested_by_label` for the detail line. Nothing else is needed.

## Fix pass (review C2-09, C2-11, C2-13)

- C2-09: the approval policy card Emergency row help now reads "Commits when raised. No approval. Flagged everywhere."
- C2-11 (my part): retro fields removed from the change form and detail types and the approvals deletion type; notify, cron and form comments reworded. History columns kept in the audit pack.
- C2-13: audit pack headers restored (`is_emergency`, blank `retro_overdue`); deprecation recorded in rtm/c2-c-openapi-notes.md.
- UAT-036: one helper `web/src/components/governance/tier-label.ts` (`tierLabel`) now words every tier badge: review queue, change detail, Approvals deletion rows (red for Emergency). Test: `web/src/components/governance/tier-label.test.ts`.

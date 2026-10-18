# C2-C OpenAPI and llms.txt notes (for the docs agent)

## PATCH /api/integrations/github/connector (rules)

- Replace the sentence that lists the allowed rule values. The values are now `unstarted | started | in_review | canceled`, or `null` for "leave the task as it is". `completed` is not accepted.
- Add 422: `{ error: "Validation failed", fields: [{ field: "rules", message: "rules.<event>: A work event cannot complete a task. Completing a task is a human action; map the event to unstarted, started, in_review or canceled, or leave it unset." }] }`.
- Default mapping text: `pr_opened` started, `pr_merged` in_review, `pr_closed` none, `deploy_success` none, `deploy_failure` none.
- The GET response field `rule_targets` now lists four values (no `completed`).
- A workspace that stored `completed` before this change reads back as `null` for that event until migration 0106 rewrites it.
- Line 358 of `openapi.json/route.ts` (work-event `kind` enum) is unchanged. Line 4103 (the rules description) needs the new value list. llms.txt: wherever the GitHub rules are described, say a GitHub event never completes a task and only a person does.

## Change request payloads (list, detail, review items, weekly report)

- Wording only, no new field: an emergency change request commits when raised, has no approver, and carries `is_emergency: true` and `tier: "emergency"`. Remove any sentence saying it owes a retro approval or becomes overdue.

## Weekly report (GET /api/reports/weekly, stored report, Lark weekly card)

- The report gains a section "Emergency changes this week: N" listing up to ten references and titles of emergency change requests raised in the last 7 days. It replaces the line about emergency changes overdue for approval, which is gone.
- The stored digest field is `emergencyChanges: { count, items: [{ reference, title }] }` (replaces `retroOverdue`). Reports stored before this change have neither field and render "Emergency changes this week: 0".

## Audit pack export (GET /api/export?entity=audit_pack, change-request sheet)

- Columns: `tier`, `emergency` (`yes` or `no`), `retro_due_at`, `retro_decided_at`, `retro_outcome`. `is_emergency` and `retro_overdue` are removed. The `retro_*` columns are history for emergencies raised before the retro was retired.

## Fix pass (review C2-13): audit pack headers restored

This replaces the audit pack section above. The CSV header is NOT renamed:

- Columns: `tier`, `is_emergency` (`yes` or blank, as before), `retro_due_at`, `retro_decided_at`, `retro_outcome`, `retro_overdue`.
- `retro_overdue` is DEPRECATED. It is always blank in this release and will be dropped in a later release. Say so wherever the audit pack columns are described.
- `retro_due_at`, `retro_decided_at` and `retro_outcome` are history for emergencies raised before the retro was retired.
- There is no `emergency` column.

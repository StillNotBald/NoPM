# 12 · Post-release checks (wave 5, migrations 0107–0114)

*Wave 5, W5-J (R-180). For the owner. Read-only.*

**Every statement in this file is a `select`.** You paste a block into the Supabase SQL editor (project: the live NoPM project) and read the result. Nothing here writes a row, changes a setting or runs a probe. No probe, request or script in this file targets the live system: the local-DB probes refuse anything that is not loopback, and the rehearsal (`web/scripts/local-db/rehearse-wave5.mjs`) runs on your own computer only. A test (`post-release-checks.test.ts`) fails if a block in this file contains anything but a `select`.

Where a result differs, the fix is never "edit the row by hand". The "If it differs" line says whether to stop, roll back (see [14-WAVE5-RELEASE.md](14-WAVE5-RELEASE.md)), or just write it down.

## How to use it

Run the group that matches the step you just finished. Each check has an id, the block, what you should see, and what to do if you do not.

| Group | Run it after | Before the next step you need |
|---|---|---|
| 0 Baseline | before anything | the numbers written down |
| 1 After 0107–0113 | the first migration run (before the deploy) | every check green |
| 2 After the deploy | the new build is serving | every check green |
| 3 After 0114 | the second migration run | every check green |
| 4 After the anchor variable | you set `NOPM_ANCHOR_DB_URL` (optional, last) | the anchor card reads "Anchored" |

An empty result is never a pass. Every block below returns at least one row, except four lists (1.5 audit rows, 2.4, 2.5 and 3.4), where the Expect line says what no rows means.

Assumption used for the counts: the live ledger is at 0105 (102 rows) when you start, so 0106 (cycle 2, PR #11) ships in the same window. If PR #11 was released on its own first, the ledger starts at 103 and ends at the same 111; only the "files pending" count in the dry run changes (7 instead of 8).

---

## Group 0 · Baseline (before step 1)

### 0.1 Where the ledger stands

```sql
select count(*) as ledger_rows, max(name) as last_applied from _nopm_migrations;
```

- **Expect:** 102 rows, last `20261018000105_github_work_events.sql`. Or 103 rows and `20261018000106_tier_decisions.sql` if PR #11 is already live.
- **If it differs:** stop. The live database is not where the runbook assumes. Compare with the run record in [11-AUDIT-GAPS.md](11-AUDIT-GAPS.md) and ask before applying anything.

### 0.2 Row counts to compare with later

```sql
select
  (select count(*) from audit_log) as audit_rows,
  (select count(*) from change_requests) as change_requests,
  (select count(*) from deletion_requests) as deletion_requests,
  (select count(*) from projects) as projects,
  (select count(*) from tasks) as tasks,
  (select count(*) from programs) as programs,
  (select count(*) from sprints) as sprints,
  (select count(*) from resource_members) as resource_members,
  (select count(*) from allocations) as allocations,
  (select count(*) from clashes) as clashes,
  (select count(*) from user_mfa) as user_mfa;
```

- **Expect:** a row of numbers. Write them down.
- **Use:** none of 0107–0114 removes a row. After each step every number is the same or higher. A lower number means somebody deleted something in the window: find out who before going on. `audit_rows` only ever grows.

### 0.3 Change requests by status (needed for the 0106 check)

```sql
select status, count(*) as requests from change_requests group by status order by status;
```

- **Expect:** a list. Note the `emergency` count (it may be 0, or absent).
- **Use:** migration 0106 closes every emergency that still waits for a retro decision. Group 1 shows the count afterwards. The retired `emergency` status can leave the code's status lists only once the count in 1.5 is zero after the release; then remove it from the decidable and open status lists and from the MCP tool status list in the next wave (see the sign-off in [14-WAVE5-RELEASE.md](14-WAVE5-RELEASE.md)).

---

## Group 1 · After 0107–0113 (before the deploy)

The old build is still serving. These files are additive, so it keeps working.

### 1.1 Ledger: no gaps from 0087 to 0113, and 0114 not yet in

```sql
select
  count(*) as expected_files,
  count(*) filter (where l.name is null) as missing,
  (select count(*) from _nopm_migrations) as ledger_rows,
  (select max(name) from _nopm_migrations) as last_applied
from generate_series(87, 113) as g(n)
left join _nopm_migrations l
  on substring(l.name from '^\d{8}(\d{6})_')::int = g.n;
```

- **Expect:** `expected_files` 27, `missing` 0, `ledger_rows` 110, `last_applied` `20261018000113_deletion_by_request_registers.sql`.
- **If it differs:** `missing` above 0 means a file did not apply (the atomic run should make that impossible; look at the run output). `last_applied` ending 0114 means 0114 went in early: run check 1.8 and read the "0114 applied too early" line in the runbook.

### 1.2 The new database objects exist

```sql
with wanted(name) as (values
  ('nopm_audit_insert'), ('nopm_clash_auto_resolve'), ('nopm_commit_allocation_deletion'),
  ('nopm_commit_clash_deletion'), ('nopm_commit_program_deletion'), ('nopm_commit_resource_deletion'),
  ('nopm_commit_sprint_deletion'), ('nopm_commit_task_deletion'), ('nopm_connector_write'),
  ('nopm_deletion_tier_default'), ('nopm_edit_change_request'), ('nopm_github_connector_write'),
  ('nopm_lark_connector_audit_view'), ('nopm_link_identity'), ('nopm_mask_external_id'),
  ('nopm_mfa_challenge'), ('nopm_mfa_disable'), ('nopm_mfa_enroll'), ('nopm_mfa_verify'),
  ('nopm_overspend_cross'), ('nopm_propose_rebaseline'), ('nopm_raise_change_request'),
  ('nopm_reject_deletion_request'), ('nopm_request_deletion'), ('nopm_revoke_other_invites'),
  ('nopm_snapshot_run'), ('nopm_weekly_report_store'), ('nopm_withdraw_change_request'),
  ('nopm_withdraw_deletion_request')
)
select
  count(*) as wanted_functions,
  count(p.proname) as found_functions,
  coalesce(string_agg(w.name, ', ') filter (where p.proname is null), 'none') as missing,
  to_regclass('public.audit_anchor_receipts') is not null as receipts_table,
  to_regclass('public.nopm_deletion_entities') is not null as entities_table,
  (select count(*) from nopm_deletion_entities) as deletion_entities,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks' and column_name in ('blocker_reason', 'eta')) as task_columns
from wanted w
left join (select distinct proname from pg_proc where pronamespace = 'public'::regnamespace) p on p.proname = w.name;
```

- **Expect:** `wanted_functions` 29, `found_functions` 29, `missing` none, both tables true, `deletion_entities` 12, `task_columns` 2.
- **If it differs:** a function named in `missing` was not created. Do not deploy. The atomic run rolls back as a whole, so this should not happen; if it does, keep the dump from step 2 and ask.

### 1.3 Constraints: validated, not left NOT VALID

```sql
select
  count(*) as found,
  count(*) filter (where not convalidated) as not_validated,
  coalesce(string_agg(conname, ', ' order by conname) filter (where not convalidated), 'none') as which
from pg_constraint
where conname in (
  'projects_lock_integrity',
  'cr_principal_distinct', 'deletion_principal_distinct', 'ts_principal_distinct',
  'cr_implemented_after_decision', 'cr_implemented_status_stamp', 'cr_implemented_needs_decision', 'cr_impact_scope_array',
  'cr_emergency_shape', 'cr_maker_checker',
  'deletion_requests_target_type_check',
  'integration_deliveries_approval_kind_check', 'action_tokens_approval_kind_check',
  'audit_anchor_receipts_status_check'
);
```

- **Expect:** `found` 14, `not_validated` 0, `which` none.
- **If it differs:** these checks are validated inside the migrations, and a migration only prints a notice when validation fails (it does not stop the run). A name in `which` is still enforced for every new write, but an old row breaks it.
  - `cr_principal_distinct` or `deletion_principal_distinct`: expected when [11-AUDIT-GAPS.md](11-AUDIT-GAPS.md) "Known consequences" counted historical self-approvals. They stay frozen by decision. Write the count down.
  - `projects_lock_integrity`, `cr_emergency_shape`, `cr_maker_checker` or any other name: run 1.3b below to see the rows, and send me the result. Do not edit the rows.
- `found` below 14 means a constraint is missing entirely: stop.

### 1.3b Which rows break the checks (run only if 1.3 listed a name)

```sql
select 'cr_maker_checker' as constraint_name, id::text as row_id, status::text as detail
from change_requests
where not (
  status in ('raised', 'under_review')
  or (is_emergency and status in ('emergency', 'approved', 'implemented') and decided_by_id is null)
  or (decided_by_id is not null and (requested_by_id is null or decided_by_id <> requested_by_id or decided_by_type <> requested_by_type))
)
union all
select 'cr_emergency_shape', id::text, status::text
from change_requests
where not (
  is_emergency = (tier = 'emergency')
  and (status <> 'emergency' or is_emergency)
  and (retro_outcome is null or (retro_outcome in ('approved', 'rejected', 'deferred', 'not_required', 'retired') and is_emergency))
  and ((retro_outcome is null) = (retro_decided_at is null))
)
union all
select 'projects_lock_integrity', id::text, name
from projects
where is_locked and (locked_at is null or locked_by_actor_id is null)
union all
select 'none', null, 'no row breaks these three checks';
```

- **Expect:** only the last line, `none`.
- **If it differs:** each other line is an old row that breaks a rule. Write down the ids. They are legacy data; the product keeps working.

### 1.4 Locks (K3) and the ERP-EMEA project

```sql
select
  count(*) filter (where is_locked) as locked_projects,
  count(*) filter (where is_locked and locked_by is null) as locked_without_locker,
  count(*) filter (where is_locked and locked_by = '00000000-0000-0000-0000-000000000000'::uuid) as locked_by_nil_uuid,
  count(*) filter (where is_locked and locked_by_actor_id = '00000000-0000-0000-0000-000000000000'::uuid) as actor_nil_uuid,
  count(*) filter (where is_locked and (locked_at is null or locked_by_actor_id is null)) as lock_without_stamp
from projects;
```

- **Expect:** `lock_without_stamp` 0 (the 0088 check). `locked_by_nil_uuid` 0. The other columns are information: `actor_nil_uuid` counts locks whose locker was not recorded when 0088 ran ("legacy lock"); a token or connector lock has no person, so `locked_without_locker` may be above 0.
- **If it differs:** a non-zero `lock_without_stamp` or `locked_by_nil_uuid` is a defect. Write it down and send it; do not unlock anything to "fix" the number.

Now the project you care about. Edit the name pattern between the percent signs to match your project.

```sql
select id, name, is_locked, locked_at, locked_by, locked_by_actor_type, locked_by_actor_id, locked_by_label
from projects
where name ilike '%EMEA%'
order by name;
```

- **Expect:** a row for the project. If it is locked, `locked_at` and `locked_by_label` are filled.
- **If it differs:** no row means the pattern is wrong; change it. A locked row with an empty label or time is the defect above.

### 1.5 The 0106 data step (only when 0106 was in this release)

These counts say what the migration changed. The step is safe to run again, and it reports zero the second time.

```sql
select
  (select count(*) from change_requests where status = 'emergency') as emergency_status,
  (select count(*) from change_requests where is_emergency and retro_decided_at is null) as emergency_waiting_retro,
  (select count(*) from change_requests where retro_outcome = 'retired') as retired_retros,
  (select count(*) from change_requests where retro_due_at is not null or retro_decided_at is not null or retro_outcome is not null) as with_retro_column_set,
  (select count(*) from workspaces w
    where exists (select 1 from jsonb_each(w.work_event_rules) e where e.value = '"completed"'::jsonb)) as workspaces_with_completed_rule,
  (select count(*)
     from deletion_requests d
     join expenses e on e.id = d.target_id and e.workspace_id = d.workspace_id
     join workspaces w on w.id = d.workspace_id
    where d.target_type = 'expense' and d.status::text = 'pending' and d.tier = 'normal'
      and abs(coalesce(e.amount, 0)) <> 0
      and abs(coalesce(e.amount, 0)) >= coalesce((w.approval_policy ->> 'currency_threshold')::numeric, 50000)) as expense_deletions_below_high_risk,
  (select count(*)
     from deletion_requests d
     join documents x on x.id = d.target_id and x.workspace_id = d.workspace_id
    where d.target_type = 'document' and d.status::text = 'pending' and d.tier = 'high_risk' and x.status = 'approved') as approved_document_deletions_on_admin_tier;
```

- **Expect:** `emergency_status` 0, `emergency_waiting_retro` 0, `workspaces_with_completed_rule` 0, `expense_deletions_below_high_risk` 0, `approved_document_deletions_on_admin_tier` 0. `retired_retros` and `with_retro_column_set` are history: they count what 0106 retired and what older emergencies still carry, and stay above 0 if you ever raised an emergency.
- **If it differs:** a non-zero in one of the five zero columns is a straggler: a request written in the old shape by the old build after the migration ran. The documented repair is the function in [11-AUDIT-GAPS.md](11-AUDIT-GAPS.md) "Cycle 2 addition". It is a write, so it is not in this file. Do it after the old build is gone (Group 2), then run this block again.

What the data step wrote, one audit row per request or workspace:

```sql
select action, count(*) as audit_rows, min(created_at) as first_at, max(created_at) as last_at
from audit_log
where actor_label = 'system (migration 0106)'
group by action
order by action;
```

- **Expect:** rows for the actions that applied: `change_request.retro_retired`, `deletion_request.tier_raised`, `deletion_request.tier_lowered`, `work_event_rules.%`. A missing action just means nothing needed changing. The counts equal the NOTICE lines of the migration run. No rows at all is fine when none of the cases existed (compare with 0.3).
- **If it differs:** more rows than the NOTICE counts is unexpected: send both.

### 1.6 Audit chain (the verify call, and gaps)

Gapless per workspace. A gap means a row is missing from the middle of the chain.

```sql
select
  workspace_id,
  count(*) as audit_rows,
  min(chain_seq) as first_seq,
  max(chain_seq) as last_seq,
  (max(chain_seq) - min(chain_seq) + 1) - count(*) as gaps,
  count(*) filter (where row_hash is null) as unhashed
from audit_log
group by workspace_id
order by workspace_id;
```

- **Expect:** one row per workspace with audit rows; `first_seq` 1, `gaps` 0, `unhashed` 0.
- **If it differs:** stop. A gap or an unhashed row is a broken chain. Do not deploy. Send the output.

The chain verify call itself, once for every workspace. This is the same function the Trust Center runs (it reads, and writes nothing).

```sql
select w.id as workspace_id, w.name, v.ok, v.checked, v.first_bad_id, v.first_bad_at, v.first_seq
from workspaces w
cross join lateral nopm_audit_verify_chain(w.id) v
order by w.name;
```

- **Expect:** `ok` true for every workspace, `first_bad_id` empty, `checked` equal to that workspace's `audit_rows` above. A workspace with no audit rows shows `checked` 0. The function stops at 50,000 rows, so a bigger log shows 50,000.
- **If it differs:** stop. `ok` false names the first row where the hash does not match.

The head of the chain, to write down outside the database (see [11-AUDIT-GAPS.md](11-AUDIT-GAPS.md) "Hash chain: keep a head hash outside the database"). It must equal the `head_hash` the verify route returns, and the last `audit.verified` row.

```sql
select
  h.workspace_id,
  h.last_seq,
  h.head_hash,
  (select max(a.created_at) from audit_log a where a.workspace_id = h.workspace_id and a.action = 'audit.verified') as last_verified_at
from (
  select distinct on (workspace_id) workspace_id, chain_seq as last_seq, row_hash as head_hash
  from audit_log
  order by workspace_id, chain_seq desc
) h
order by h.workspace_id;
```

- **Expect:** one row per workspace. `last_verified_at` is empty until somebody presses "Verify now" once; after that it is recent.
- **Use:** copy `head_hash` and `last_seq` into the email or ticket the owner keeps. Compare it with the next release.

### 1.7 Two-step sign-in rows (`user_mfa.backup_codes`)

The column has been `NOT NULL` since migration 0002, and the old enrol and disable routes wrote a null into it. If so, enrolling or disabling two-step sign-in could have failed with a server error on live all along. The new functions write an empty list instead.

```sql
select
  count(*) as mfa_rows,
  count(*) filter (where enabled) as enabled,
  count(*) filter (where not enabled) as pending_or_disabled,
  count(*) filter (where enabled and cardinality(backup_codes) = 0) as enabled_without_codes,
  (select count(*) from audit_log where action like 'mfa.%') as mfa_audit_rows,
  (select count(*) from audit_log where action like 'mfa.%' and created_at > now() - interval '30 days') as mfa_audit_rows_30d
from user_mfa;
```

- **Expect:** any numbers; `enabled_without_codes` 0. If `mfa_rows` is 0 and `mfa_audit_rows` is above 0, people tried and the old routes could not store the row: that is the finding. Write it down.
- **If it differs:** `enabled_without_codes` above 0 is a person who enabled sign-in and has no recovery codes. Tell that person to disable and enrol again after the deploy.
- **After the deploy:** look at the server logs for the `/api/auth/mfa` routes. Five hundreds before the deploy are the old bug; after it there should be none.

### 1.8 The five new delete-refusing triggers are not in yet

Only the five from migration 0102 exist now (risks, issues, expenses, documents, milestones). The five registers get theirs in 0114, after the deploy.

```sql
select
  count(*) as delete_refusing_triggers,
  count(*) filter (where c.relname in ('programs', 'sprints', 'resource_members', 'allocations', 'clashes')) as on_the_five_registers,
  count(*) filter (where t.tgenabled <> 'O') as not_enabled
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where t.tgname like 'trg\_%\_delete\_needs\_request';
```

- **Expect:** `delete_refusing_triggers` 5, `on_the_five_registers` 0, `not_enabled` 0.
- **If it differs:** `on_the_five_registers` above 0 means 0114 went in early. The old build's delete buttons for programs, sprints, resources, allocations and clashes fail until the new build is serving. Deploy now, or roll 0114 back with the single line in [14-WAVE5-RELEASE.md](14-WAVE5-RELEASE.md).

---

## Group 2 · After the deploy (new build serving, 0114 not yet applied)

Outside the database first: `curl https://stillnotbald.com/api/health` answers 200, and `node scripts/auth-smoke.mjs` passes. Then:

### 2.1 Re-check the 0106 stragglers

The old build served for a few minutes after phase 1. Run the 1.5 count block again.

- **Expect:** the five zero columns are 0.
- **If it differs:** repair with the function in [11-AUDIT-GAPS.md](11-AUDIT-GAPS.md), now that the old build is gone, then run the block again.

### 2.2 Writes from the new build carry an audit row

Edit the interval to cover the time since the deploy. The new build saves the change and its audit row in one transaction, so a change without a row must not exist.

```sql
select
  (select count(*) from audit_log where created_at > now() - interval '3 hours') as audit_rows_since,
  (select count(*) from deletion_requests d
    where d.created_at > now() - interval '3 hours'
      and not exists (select 1 from audit_log a
                       where a.workspace_id = d.workspace_id and a.target_id = d.target_id
                         and split_part(a.action, '.', 2) = 'delete_requested')) as deletion_requests_without_audit,
  (select count(*) from change_requests c
    where c.created_at > now() - interval '3 hours'
      and not exists (select 1 from audit_log a where a.target_id = c.id and a.action like 'change\_request.%')) as change_requests_without_audit;
```

- **Expect:** `deletion_requests_without_audit` 0 and `change_requests_without_audit` 0. `audit_rows_since` above 0 once anyone has used the app. Use only the window after the deploy: older requests are not in scope.
- **How it matches:** a deletion request is raised with an audit row named `<kind>.delete_requested` whose target is the record to delete (the `deletion_request.*` rows only appear once somebody decides). A change request is matched by its own id.
- **If it differs:** do not roll back on this number alone. Run 2.2b to see the requests, then decide. A count above 0 is only a finding if the request came from the app in the window and truly has no row. A request you inserted by hand, or one raised before the deploy, explains itself. If a genuine app request has no audit row, send me the 2.2b output before any rollback.

### 2.2b Which requests (run only if 2.2 shows a count)

```sql
select 'deletion_request' as kind, d.id, d.target_type as detail, d.created_at
from deletion_requests d
where d.created_at > now() - interval '3 hours'
  and not exists (select 1 from audit_log a
                   where a.workspace_id = d.workspace_id and a.target_id = d.target_id
                     and split_part(a.action, '.', 2) = 'delete_requested')
union all
select 'change_request', c.id, c.status::text, c.created_at
from change_requests c
where c.created_at > now() - interval '3 hours'
  and not exists (select 1 from audit_log a where a.target_id = c.id and a.action like 'change\_request.%')
union all
select 'none', null, 'no request without an audit row', null
order by created_at desc nulls last;
```

- **Expect:** only the `none` line.

### 2.3 Chain still intact after the new build wrote

Run the three 1.6 blocks again (gaps, verify per workspace, head).

- **Expect:** `gaps` 0, `unhashed` 0, `ok` true for every workspace, and each `last_seq` higher than before if anyone used the app.
- **If it differs:** stop. Roll back the app.

### 2.4 Two-step sign-in works now

After somebody has enrolled or disabled two-step sign-in on the new build:

```sql
select action, count(*) as audit_rows, max(created_at) as latest
from audit_log
where action like 'mfa.%' and created_at > now() - interval '3 hours'
group by action
order by action;
```

- **Expect:** a row per action used, if anyone tried. Run the 1.7 block again: `enabled_without_codes` stays 0.
- **If it differs:** no row, but the smoke tester did try: look at the server log for a 500 on the mfa routes.

### 2.5 The scheduled jobs wrote their rows

The nightly snapshot job and the weekly report run on the schedule, so this one is for the morning after. No rows at all means none of these events happened yet.

```sql
select action, count(*) as audit_rows, max(created_at) as latest
from audit_log
where action in ('snapshot.taken', 'report.weekly', 'budget.overspend', 'clash.auto_detected', 'clash.auto_resolve')
group by action
order by action;
```

- **Expect:** `snapshot.taken` has a row from after the deploy. The others appear only when the event happened.
- **If it differs:** no new `snapshot.taken` row the morning after the deploy: check that the cron secret is still set on the host.

---

## Group 3 · After 0114 (second migration run)

### 3.1 Ledger complete

```sql
select
  count(*) as expected_files,
  count(*) filter (where l.name is null) as missing,
  (select count(*) from _nopm_migrations) as ledger_rows,
  (select max(name) from _nopm_migrations) as last_applied
from generate_series(87, 114) as g(n)
left join _nopm_migrations l
  on substring(l.name from '^\d{8}(\d{6})_')::int = g.n;
```

- **Expect:** `expected_files` 28, `missing` 0, `ledger_rows` 111, `last_applied` `20261018000114_deletion_refuse_triggers.sql`.
- **If it differs:** 110 rows means 0114 did not apply. Read its error: it refuses to run when the 0113 commit functions are not in place, and nothing is left half-applied.

### 3.2 All ten delete-refusing triggers are on and enabled

```sql
select
  count(*) as delete_refusing_triggers,
  count(*) filter (where c.relname in ('programs', 'sprints', 'resource_members', 'allocations', 'clashes')) as on_the_five_registers,
  count(*) filter (where c.relname in ('risks', 'issues', 'expenses', 'documents', 'milestones')) as on_the_0102_five,
  count(*) filter (where t.tgenabled <> 'O') as not_enabled
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where t.tgname like 'trg\_%\_delete\_needs\_request';
```

- **Expect:** `delete_refusing_triggers` 10, five and five, `not_enabled` 0.
- **If it differs:** fewer than ten: the missing table still allows a direct removal. Send the output.

### 3.3 Every commit function that cascades sets the flag

A task or project approval removes rows from the five registers. It works only if the commit function sets the transaction flag the triggers look for.

```sql
select
  count(*) as commit_functions,
  count(*) filter (where position('nopm.deletion_commit' in p.prosrc) > 0) as set_the_flag,
  coalesce(string_agg(p.proname, ', ') filter (where position('nopm.deletion_commit' in p.prosrc) = 0), 'none') as without_flag
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'nopm_commit_task_deletion', 'nopm_commit_project_deletion', 'nopm_commit_program_deletion',
    'nopm_commit_sprint_deletion', 'nopm_commit_resource_deletion', 'nopm_commit_allocation_deletion',
    'nopm_commit_clash_deletion', 'nopm_commit_risk_deletion', 'nopm_commit_issue_deletion',
    'nopm_commit_expense_deletion', 'nopm_commit_document_deletion', 'nopm_commit_milestone_deletion'
  );
```

- **Expect:** 12, 12, `without_flag` none.
- **If it differs:** a function listed in `without_flag` would fail its approvals with a DELETE_NEEDS_REQUEST error. Roll 0114 back (the five-line statement in [14-WAVE5-RELEASE.md](14-WAVE5-RELEASE.md)) and send the output.

### 3.4 Deletion requests by kind

```sql
select target_type, status::text as status, count(*) as requests, max(created_at) as latest
from deletion_requests
group by target_type, status
order by target_type, status;
```

- **Expect:** a list. After the smoke test there is a row for the kind you tried, and an approved request shows `committed`.
- **If it differs:** a request that stays `pending` after an approval attempt, or a row that is `approved` but has no `committed_at`, means the approval failed. Look at the app error.

### 3.5 Counts did not drop, chain still intact

Run 0.2 again and compare with the baseline: every number is the same or higher. Run the three 1.6 blocks again.

- **Expect:** no number lower than at baseline except where real people deleted things through requests you can see in 3.4. `ok` true, `gaps` 0, `unhashed` 0.
- **If it differs:** a lower count with no matching request is lost data. Stop, restore from the dump if needed ([04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md)), and ask.

---

## Group 4 · After the anchor variable (optional, last)

You set `NOPM_ANCHOR_DB_URL`, redeployed, and pressed "Verify now" in the Trust Center as an admin. See [13-AUDIT-ANCHOR.md](13-AUDIT-ANCHOR.md).

### 4.1 The anchor state per workspace (read from the app database)

```sql
select
  w.id as workspace_id,
  w.name,
  coalesce(r.status, 'no row (not anchored)') as status,
  r.chain_seq as anchored_seq,
  left(r.head_hash, 12) as anchored_head,
  r.row_count,
  r.anchored_at,
  r.streak_started_at,
  r.error_text,
  (select max(a.chain_seq) from audit_log a where a.workspace_id = w.id) as live_seq,
  (select max(a.chain_seq) from audit_log a where a.workspace_id = w.id) - r.chain_seq as rows_behind
from workspaces w
left join audit_anchor_receipts r on r.workspace_id = w.id
order by w.name;
```

- **Expect:** `status` `anchored` for the workspace you verified, `error_text` and `streak_started_at` empty, `rows_behind` 0 right after the press (a small number later is normal: the log grows between daily runs).
- **If it differs:** `no row` means that workspace was never anchored (press "Verify now" in it). `failed` means the anchor database could not be reached: check the connection string and the role. `mismatch` means the live log differs from the outside copy: follow "If it says Mismatch" in [13-AUDIT-ANCHOR.md](13-AUDIT-ANCHOR.md) and change nothing.
- This table is bookkeeping for the screen. It is not evidence: only the anchor database is.

### 4.2 The anchor audit trail

```sql
select
  count(*) filter (where action = 'audit.anchored') as anchored_rows,
  count(*) filter (where action = 'audit.anchor_failed') as failed_rows,
  count(*) filter (where action = 'audit.anchor_mismatch') as mismatch_rows,
  max(created_at) filter (where action = 'audit.anchored') as last_anchored_at
from audit_log
where action like 'audit.anchor%';
```

- **Expect:** `anchored_rows` at least 1 after the first press, `mismatch_rows` 0. `failed_rows` is 0, or each failure streak is followed by a later `audit.anchored` row.
- **If it differs:** `mismatch_rows` above 0 is the red state on the Trust Center. Same advice as 4.1.

### 4.3 Verify, and the verify row itself

```sql
select workspace_id, created_at, after ->> 'ok' as ok, after ->> 'head_hash' as head_hash, after #>> '{anchor,state}' as anchor_state_at_verify
from audit_log
where action = 'audit.verified'
order by created_at desc
limit 5;
```

- **Expect:** the newest row `ok` true, a `head_hash` that matches the head you wrote down in 1.6 (or a later one), and an `anchor_state_at_verify` that reads `not_anchored` on the very first press (the state before anchoring) and `anchored` or `behind` afterwards.
- **If it differs:** `ok` false is the same as a failed verify in 1.6: stop and send the row.

### 4.4 Read the outside copy (run in the SECOND database, not the NoPM one)

Open the SQL editor of the anchor database (the project you made for the anchor, under its own login) and run:

```sql
select workspace_id, chain_seq, left(head_hash, 12) as head, row_count, anchored_at
from audit_anchors
order by anchored_at desc
limit 10;
```

- **Expect:** a row per anchored workspace. The newest `chain_seq` for a workspace equals the `anchored_seq` in 4.1, and the `head` starts the same as `anchored_head`.
- **If it differs:** the app database and the anchor database disagree about what was anchored. That is exactly what the anchor exists to show. Change nothing; follow [13-AUDIT-ANCHOR.md](13-AUDIT-ANCHOR.md).

---

## Sign-off

| Group | Done | Date | Notes (numbers from 0.2, the head hash from 1.6) |
|---|---|---|---|
| 0 Baseline | | | |
| 1 After 0107–0113 | | | |
| 2 After the deploy | | | |
| 3 After 0114 | | | |
| 4 After the anchor | | | |

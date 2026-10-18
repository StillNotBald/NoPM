# W5-I retro leftovers and seed domain (R-178, R-179)

- **R-178** Retire the emergency retro leftovers (audit G4). **DONE** for (a), (b), (d). (c) is deliberately not done, see below.
  - (a) The retro model has no reader, type, help text or test title left except the three history columns (`retro_due_at`, `retro_decided_at`, `retro_outcome`), the `retro_overdue` approval-event kind, and tests that assert the retirement. `timers.test.ts` title fixed. Comments added to `approval-events.ts` and `lib/api/views.ts` marking both as history.
  - (b) `emergency_retro_hours` removed from the `ApprovalPolicy` type, the default policy, `policyOf`, and the constants `DEFAULT_EMERGENCY_RETRO_HOURS` and `MAX_RETRO_HOURS`. `validatePolicyInput` still accepts the key and ignores it (D17). GET `/api/workspace-settings` no longer returns it. The 0100 DB validator keeps accepting it as optional, so no migration is needed. No UI shows it.
  - (c) NOT DONE: `emergency` stays in the decidable and open status lists and in `CHANGE_REQUEST_STATUSES` (`web/mcp/tools.mjs`), now commented as a legacy filter value. The `CUTOVER/12` live check (change requests in status `emergency`) has not been run, so removal is left for after it.
  - (d) Audit-pack CSV unchanged: `is_emergency` yes or blank, blank `retro_overdue` kept one more release.
- **R-179** Seed logins on a neutral domain. **DONE** `web/scripts/seed-members.mjs` and `web/scripts/seed-approvals.mjs` now use `priya.nair@example.com` and `daniel.okoro@example.com`. No docs under `docs/` quoted the old addresses. The cycle-2 BRIEF (historical) still names the old addresses for the already-seeded local database.

| Req | Code | Test |
|---|---|---|
| R-178 | `src/lib/governance/tiers.ts`, `approval-events.ts`, `src/lib/api/views.ts`, `mcp/tools.mjs` | `tiers.test.ts`, `route.policy.test.ts`, `timers.test.ts`, `route.tiers.test.ts` |
| R-179 | `scripts/seed-members.mjs`, `scripts/seed-approvals.mjs` | none (scripts) |

## Hit list (retro, 48 h, emergency_retro_hours, retro_window in web/src, web/mcp, cli, web/scripts)
- Before: typed field and defaults in `tiers.ts`; stale title in `timers.test.ts`; unmarked history columns/kind; test assertions of `48`.
- After: only history columns, the `retro_overdue` kind, the audit action `change_request.retro_retired`, the accepted-and-ignored key, and tests asserting the retirement. The `48 h` hits are the normal-tier turnaround, not the retro. `deadline_overdue` is the approval deadline, not the retro. `cli/` has no hits.

## Later migration (no slot this wave)
Remove `retro_overdue` from the `approval_events.kind` CHECK for new rows without dropping old rows:
```sql
alter table approval_events drop constraint approval_events_kind_check;
alter table approval_events add constraint approval_events_kind_check
  check (kind in ('deadline_set','reminder_sent','escalated','auto_approved','retro_overdue')) not valid;
-- not valid keeps existing retro_overdue rows; to forbid new ones use a trigger, since a CHECK cannot tell old from new.
```
Verify the real constraint name and value list in migration 0101 first. Dropping the three `retro_*` columns and `retro_open_idx` is also deferred; they hold history.

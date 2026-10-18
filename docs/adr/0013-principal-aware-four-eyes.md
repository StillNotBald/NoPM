# ADR 0013 — Principal-aware four-eyes

- **Status:** Accepted (owner, 2026-10-16)
- **Date:** 2026-10-16

## Context

Four-eyes (maker-checker) is enforced by comparing the actor who requested a governed change with the actor who decides it. An actor is either a signed-in user or a personal access token (PAT). Today the comparison uses the actor's id: the profile id for a session, the token's id for a PAT.

That is the defect. The same person can hold a session and also own a PAT minted in the token settings. They can raise a deletion request, change request, timesheet submission or rebaseline in the console as themselves, then approve it with their own token. The two ids differ, so the check passes, and the approval is recorded as an independent decision with no second person involved. The reverse works too. UC-12 and ADR 0006 describe the rule as "approver ≠ requester". Under the current design that is true of actor ids, not of people.

The same design fault shows up in other places:

- The deletion commit RPC compares `requested_by_id` with `p_approver_id`, both of which are actor ids.
- The change-request decision route compares the actor id with the legacy requester column and with the actor-typed pair.
- Rebaseline sign-off writes the token's id into `rebaseline_signoffs.approver_id`, which references `profiles`. A token approver therefore fails the foreign key and returns a server error (500), not a clear refusal.
- Wildcard scopes (`*` and `resource:*`) include the approve and decide scopes, so a broadly scoped token can approve.

Chat approvals (ADR 0012) make the first point urgent. A card click acts through a connector. Without this change, a person could raise a request in the console and approve it from chat under a connector identity, and the check would pass. The fix has to hold before any chat path ships.

## Decision

### D1 — The principal is the accountable human

Four-eyes compares the **principal**, not the actor id.

- **Session actor:** principal = the signed-in user's id.
- **Token actor:** principal = `api_tokens.created_by`, the person who minted the token.
- **Connector action (chat):** principal = the verified, linked NoPM profile (ADR 0012).
- **A null principal can never approve.** A decision whose actor has no principal is refused with 403 and the message "This token has no recorded owner, so it cannot approve (four-eyes)."
- **Applied to every actor, including existing tokens.** This is the owner's decision of 2026-10-16. A token minted by person A cannot approve a request that person A raised.

The database enforces the same rule. Each governed table records the requester's principal and the decider's principal. A CHECK rejects any row where both principals are set and equal. The commit RPCs refuse a null principal (`NO_PRINCIPAL`, mapped to 403) and a matching principal (`SELF_APPROVAL`).

### D2 — Wildcards never grant privileged scopes

`*` and `<resource>:*` no longer imply the scopes that approve or decide:

- `task:delete:approve`
- `project:delete:approve`
- `time:approve`
- `change:decide`
- `rebaseline:approve`

Those must be granted by exact name. `hasScope` applies the rule. `PRIVILEGED_SCOPES` exports the list, so the scope check and its tests read the same list.

### Migration approach

One additive migration, `20261016000045_principal_four_eyes.sql`, applied after 0044:

1. **Additive columns.** A requester-principal column and a decider-principal column on `deletion_requests`, `change_requests`, `timesheet_submissions` and `rebaselines`, plus the matching approver column on `rebaseline_signoffs`. Nothing is dropped or renamed.
2. **Backfill.** Rows raised by a user get that user's id. Rows raised by a token get `api_tokens.created_by` for that token. A token with no recorded creator stays null.
3. **CHECKs.** A row where both principals are set and equal is rejected, as in D1. A null on either side passes the CHECK (see Consequences).
4. **RPCs.** `nopm_commit_task_deletion` and `nopm_commit_project_deletion` are recreated with an added `p_approver_principal_id uuid`. The old signatures are dropped in the same migration, because a leftover overload would be a route around the check. The 0044 provenance parameters stay.
5. **Rebaseline trigger.** The trigger from migration 0022 compares principals, not ids.

The migration and the route changes ship in one deploy. Between applying the migration and deploying the code, an old route that calls a dropped RPC signature fails closed. It cannot bypass four-eyes.

### Hardening that lands in the same change

These come from the same review and are not separate decisions:

- The change-request decision becomes a compare-and-set on status (`raised` or `under_review`). Zero rows updated returns 422 "already decided", not a race.
- The change-request create schema accepts only raise-time statuses. Today an invalid status reaches the database and leaks a raw error.
- The deletion approve route accepts an optional note and records it in the audit `after` field. The dialog's note was being dropped.
- Rebaseline sign-off by a token uses the token's principal. A token with no owner gets 403, not the foreign-key error.

## Consequences

- **Seeded and automation tokens need distinct owners.** Seed scripts mint the maker and checker tokens with different `created_by` values. A demo maker and checker that share an owner will now fail, which is correct.
- **An agent acting for person A can never approve A's request**, whichever token it uses. An agent acting for person B can approve A's request only if B's token holds the exact approve scope for that kind.
- **Tokens with `*` or `resource:*` lose approval rights on upgrade** (D2). Their owners re-mint them with exact scopes. This is the intended effect.
- **Decision rows record the decider's principal**, so a Trust Center reader sees the human behind a token decision, not only the token.
- **Known gap: requests whose requester principal cannot be recovered.** The CHECK passes when the requester principal is null. That happens for legacy token rows whose creator the backfill cannot find. Such a request can be approved by any human approver, but four-eyes cannot be proven for it, because the requester is unknown. Recommendation: the migration reports how many rows are unattributed, so the owner can decide on real data whether they should stay approvable.
- **Token rejections become clear.** A rebaseline sign-off by a token with no owner returns 403 instead of the foreign-key server error.

## Why this respects the constitution

- The four-eyes invariant is strengthened, not weakened. The CHECK keeps its shape and moves from actor ids to people.
- This ADR does not touch the audit table's immutability. Any audit change is additive and is covered in ADR 0012.
- No new scope name is added. The `hasScope` change applies only to wildcards.
- Governance stays in the data layer. The CHECK and the RPC guards hold even for a service-role writer that bypasses the API guard.

## Alternatives considered

- **Forbid tokens from approving.** Rejected. UC-12 already allows the checker to be a person or a separately scoped token used through the UI or API, and a ban would remove a legitimate checker path for scripted approvals. The principal model fixes the defect without that cost.
- **Compare names or email addresses.** Rejected. Names are not unique, and email is not a stable identity key. The principal is the profile id, which is.
- **Enforce only in the API guard.** Rejected. The API guard is one writer among several. The CHECK and the RPC guards hold for any writer, including the service role that ADR 0001 relies on.
- **Keep the old RPC signatures for compatibility.** Rejected. A signature that is still callable is a route around the check, so the old overloads are dropped, not deprecated.

## Related

- ADR 0006 (atomic deletion and scope registry), ADR 0012 (integration hub fan-out boundary).
- UC-08 (timesheets), UC-10 (change requests), UC-12 (four-eyes deletion), UC-17 (scoped tokens and agent operation).

> **Update 2026-10-17 (owner decision 18):** the timesheet flow and the `time:approve` scope named above no longer exist (hour logging was removed). The principal rule is unchanged for deletions, change requests and rebaselines. `timesheet_submissions` keeps its columns and rows but nothing writes to it.

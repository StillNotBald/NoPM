# User provisioning — seats, roles and leavers

**Status: ACTIVE** (describes the real, current mechanism). Updated 2026-10-17 after the journey audit (D-ACC-1, D-ACC-2, D-ACC-22).

## Adding a person

### Normal path: a link invite

An admin or manager (a user session, not a token) opens the invites page and creates a link invite: `POST /api/invites` with `{ email, role }`. The role can be at most the creator's own rank (a manager can invite a manager but not an admin; owner decision 8). The raw invite link is shown once and is valid for 7 days. The person opens it, sets a name and password, and lands in the workspace with that role. Revoke a pending invite with `POST /api/invites/{id}/revoke`. Accepting is retry-safe: a lost response or a double click does not strand a half-created login. Inviting an email that already has an account is refused (`409 account_exists`). See UC-19.

No email is sent (Resend stays demo-mode, per the constitution); pass the link on yourself.

### Ops path: create the login directly

For a bootstrap, or when the invite flow cannot be used, whoever holds `SUPABASE_SERVICE_ROLE_KEY` access (typically a script against `web/.env.local`, the pattern of `web/scripts/bootstrap.mjs` and `web/scripts/seed-members.mjs`) does it in two steps:

1. **Create the Supabase Auth user.** `db.auth.admin.createUser({ email, password, email_confirm: true })`, or the dashboard's Auth → Users → Add user.
2. **Assign workspace and role.** Upsert a row in `profiles`: `{ id: <auth user id>, workspace_id, role: 'admin' | 'manager' | 'member' | 'viewer', display_name, email }`. A login with no `profiles` row can sign in but gets "No workspace profile for this user" on any API call (`web/src/lib/auth/guard.ts`).

## What the roles can do

`role` is a Postgres enum: `admin`, `manager`, `member`, `viewer`.

| Role | Can |
|---|---|
| viewer | read only |
| member | read and write work records; log, edit and delete **their own** hours only (decision 17, to be confirmed) |
| manager | everything a member can, plus **approve and decide** (decision 16, ADR 0014), mint tokens, manage invites, connect integrations |
| admin | everything a manager can, plus invite admins |

Approving or deciding is for admins and managers only, on every channel; a token approves with the **current** role of the person who minted it. There is no in-app screen to change another person's role: it is a direct `profiles` update by whoever has Supabase project access.

## Removing a person (leaver procedure)

**Do not delete the login or the profile.** The earlier version of this page said that deleting the Supabase Auth user "cascades to profiles". It does not work: `profiles.id` is referenced by 31 foreign keys without `on delete` (for example `api_tokens.created_by`, `invites.created_by`, `calendar_feeds.created_by`, `projects.owner_id`, `tasks.assignee_id`, the audit-bearing request columns), so the delete fails for anyone who ever did anything, and where it did succeed it would orphan the history the audit trail points to. Keep the profile; take away the access.

Do these in order, the same day the person leaves:

1. **Revoke their tokens.** In the console, `/tokens` → Revoke on each token they created (admin or manager session), or `DELETE /api/tokens/{id}`. Revoking is immediate. A token whose creator's profile is gone stops authenticating by itself, but because you are keeping the profile, revoking is the step that matters. Pay special attention to any token carrying an approve scope: it approves with the creator's role, so a leaver who is still a manager would keep approving through it.
2. **Ban the login.** Supabase dashboard → Auth → Users → the user → Ban user (or `db.auth.admin.updateUserById(id, { ban_duration: '876000h' })` from a service-role script). A banned user cannot sign in or refresh a session. An access token already issued can live up to its expiry (about an hour); step 3 makes that residue read-only.
3. **Change their role to `viewer`.** `update profiles set role = 'viewer' where id = '<id>'` (there is no in-app screen). This makes any session residue read-only, removes them from the eligible approvers for chat cards, and makes every token they minted lose approve power at once.
4. **Revoke their pending invites.** `/invites` (or `POST /api/invites/{id}/revoke`) for any pending invite they created; an invite stays valid for 7 days regardless of who made it.
5. **Reassign their work.** Their projects (`owner_id`), tasks, allocations and open requests still point at the profile. Change owners and assignees in the console. Requests they raised that are still pending (deletion, change, timesheet, rebaseline) are decided by another manager as usual; only the original requester can withdraw a deletion request, so reject it if it should not proceed.
6. **Calendar feeds keep working.** By owner decision 9, a calendar feed does not stop when its creator leaves, because other people may be subscribed. Decide whether it should live on: list feeds with `GET /api/calendar-feeds` and revoke one with `DELETE /api/calendar-feeds/{id}`. A revoked feed's URL stops working at once.
7. **Check.** `GET /api/audit?actor_id=<profile id>&limit=5` shows nothing new after the ban. Because the role is now viewer, a Lark account still linked to them can no longer approve from chat.

Do not remove the person's resource record (`resource_members`) if you want their allocations to keep reporting correctly (any historical timesheet rows are kept in the database but are no longer shown).

Removing a seat is still an operator task today (steps 2 and 3 need Supabase access). An in-app remove and role-change screen is a backlog item (`docs/ROADMAP.md`, owner questions).

## Where to go next

- Role enforcement details and PAT scopes → [`user-manual/admin/01-workspace-admin.md`](../../user-manual/admin/01-workspace-admin.md)
- Why approving is limited to admins and managers → [`docs/adr/0014-approver-roles.md`](../adr/0014-approver-roles.md)
- Standing up a whole new workspace (not just a seat) → [`CUTOVER/01-INSTALL.md`](../../CUTOVER/01-INSTALL.md) first-admin bootstrap section

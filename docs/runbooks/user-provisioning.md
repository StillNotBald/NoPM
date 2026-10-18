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
| member | read and write work records; (hour logging was removed, decision 18) |
| manager | everything a member can, plus **approve and decide** (decision 16, ADR 0014), mint tokens, manage invites, connect integrations |
| admin | everything a manager can, plus invite admins |

Approving or deciding is for admins and managers only, on every channel; a token approves with the **current** role of the person who minted it. An admin changes a role in the People page or with `PATCH /api/members/{id}` (admin session only; last admin cannot be demoted). Two-step sign-in is required for admins and managers after a 14-day grace (decision 22).

## Removing a person (leaver procedure)

Since 2026-10-18 (migration 0083) this is one action in the app. **Do not delete the login or the profile**: `profiles.id` is referenced by 31 foreign keys without `on delete`, so a hard delete fails for anyone who ever did anything and would orphan the audit trail. NoPM keeps the profile and takes the access away.

1. **Remove the person.** An admin session: People page, Remove, or `DELETE /api/members/{id}` (a person can also remove themselves to leave). In one action this sets the profile status to `removed`, bans the login, revokes every token they minted and cancels their pending invites. Their history stays. The last admin cannot be removed (422 `last_admin`); removing someone already removed is 422 `member_removed`. Audit row `member.remove`. A token cannot do this; it is an admin session only.
2. **Reassign their work.** Their projects (`owner_id`), tasks, allocations and open requests still point at the profile. Change owners and assignees in the console. Requests they raised that are still pending (deletion, change, rebaseline) are decided by another manager as usual; the requester can withdraw their own, otherwise reject it if it should not proceed.
3. **Calendar feeds keep working.** By owner decision 9, a calendar feed does not stop when its creator leaves, because other people may be subscribed. List feeds with `GET /api/calendar-feeds` and revoke one with `DELETE /api/calendar-feeds/{id}` if it should not live on.
4. **Check.** `GET /api/audit?actor_id=<profile id>&limit=5` shows nothing new after the removal. A Lark account still linked to them can no longer approve from chat.

Coming back: `POST /api/members/{id}/restore` (admin; optional `{ role }`, capped by your own rank) un-bans the login and restores the record; a removed person who is invited again is restored the same way (`restored: true`). Lost authenticator: `POST /api/members/{id}/mfa-reset` (admin) returns fresh backup codes once; you cannot reset your own (`self_reset`).

Do not remove the person's resource record (`resource_members`) if you want their allocations to keep reporting correctly.

**Fallback if the app is unavailable** (operator with Supabase access): revoke the tokens in `/tokens`, ban the user in the Supabase dashboard (Auth, Users, Ban user), and `update profiles set role = 'viewer' where id = '<id>'`, then revoke pending invites.

## Where to go next

- Role enforcement details and PAT scopes → [`user-manual/admin/01-workspace-admin.md`](../../user-manual/admin/01-workspace-admin.md)
- Why approving is limited to admins and managers → [`docs/adr/0014-approver-roles.md`](../adr/0014-approver-roles.md)
- Standing up a whole new workspace (not just a seat) → [`CUTOVER/01-INSTALL.md`](../../CUTOVER/01-INSTALL.md) first-admin bootstrap section

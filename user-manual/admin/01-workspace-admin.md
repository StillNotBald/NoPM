# 01 · Workspace admin

**Status: ACTIVE** · Verified against `web/supabase/migrations/20260608000001_init.sql` (role enum), `web/src/lib/auth/guard.ts` (enforcement), `web/src/app/(console)/tokens/page.tsx`, `web/src/app/(console)/settings/page.tsx`, `web/src/app/api/auth/mfa/**`.

## Roles

`profiles.role` is a Postgres enum with **four** values: `admin`, `manager`, `member`, `viewer`. At the API-guard layer (`requireScope`, `web/src/lib/auth/guard.ts`): **`viewer` is read-only** (any non-`read` action is rejected, `403`); `member` can write work records; and **only `admin` and `manager` can approve or decide** (deletion approvals, change-request decisions, rebaseline sign-off and apply) — a member gets `403` "Only managers and admins can approve" (owner decision 16, ADR 0014). Managers and admins mint tokens, manage invites and connect integrations; a manager cannot invite an admin.

A token is judged by the **current** role of the person who created it: an approve scope on a token works only while its creator is an admin or manager, and stops when they are demoted.

A signed-in user's role is visible (read-only) on their own `/settings` page. There is no console UI to change *another* user's role — see [`docs/runbooks/user-provisioning.md`](../../docs/runbooks/user-provisioning.md) for how role assignment is actually done today (direct `profiles` row, by whoever has Supabase project access).

## PAT minting, scopes, and revoking

`/tokens` is a self-service page for **your own** scoped Personal Access Tokens (Bearer `npm_…`) — used by the CLI, the MCP server, or any external script. Minting a token:

- Names it and lets you pick from the scope list: `project:*`, `task:read`, `task:write`, `task:delete:request`, `task:delete:approve`, `risk:*`, `issue:*`, `clash:*`, `resource:*`, `budget:*`, `audit:read`.
- Shows the raw token **once**, at creation — it's stored server-side only as a SHA-256 hash, never logged, never retrievable again. Losing it means minting a new one.
- Token-authenticated callers use the admin client (RLS-bypassing) and are always filtered by `actor.workspaceId` server-side — a token can never reach outside its own workspace regardless of scope.

Revoking a token (also on `/tokens`) sets `revoked = true` immediately (revoking one twice answers "Token already revoked"); a revoked token's calls start failing scope checks on the next request. There is no separate "disable" state — revoke is the only off switch, and it's not reversible.

## MFA

`/settings` hosts TOTP-based MFA enroll/verify/disable (`/api/auth/mfa`, `/api/auth/mfa/enroll`, `/api/auth/mfa/verify`, `/api/auth/mfa/disable`) — a user secures their own login with an authenticator app; there's no admin-forced MFA policy today. Turning two-step off asks for a current code (or an unused backup code); enrolling while it is already on is refused ("Two-step is already on. Turn it off first."); a code works once, and after 10 wrong or repeated attempts in 5 minutes the account waits (the response says how many seconds).

## Seat provisioning

Adding a person is done with a **link invite** (admin or manager; the link is valid for 7 days). Removing a person is an operator task: revoke their tokens, ban the login, set their role to viewer — never delete the profile. See [`docs/runbooks/user-provisioning.md`](../../docs/runbooks/user-provisioning.md) for both procedures.

## Where to go next

- The real provisioning mechanism, step by step → [`docs/runbooks/user-provisioning.md`](../../docs/runbooks/user-provisioning.md)
- Standing up a fresh workspace with its own slug/name and first admin → [`CUTOVER/01-INSTALL.md`](../../CUTOVER/01-INSTALL.md) (first-admin bootstrap section)

## Update 2026-10-18 - common-pattern answers

- People page and `/api/members`: an admin changes a role, removes a person (login banned, tokens revoked, pending invites cancelled, history kept), restores a removed person, or resets another person's two-step (new backup codes shown once). The last admin cannot be removed or demoted. Managers can list members. Session only, never a token.
- Two-step is required for admins and managers after a 14-day grace period that starts at release (or when someone becomes an admin or manager). Afterwards the console sends them to Settings to enrol. Tokens keep working.
- New tokens default to 90 days (maximum 365); the token list marks those with under 14 days left. A manager cannot revoke something an admin created. An expired invite can be renewed.
- Workspace time zone (admin only, default Asia/Kuala_Lumpur) and failed chat messages with a Retry button are on the integrations page.
- Owner step: the 14-day session length is a Supabase dashboard setting (Auth, Sessions; Pro plan). It is not set by the code.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

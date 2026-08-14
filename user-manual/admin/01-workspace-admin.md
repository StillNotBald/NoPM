# 01 · Workspace admin

**Status: ACTIVE** · Verified against `web/supabase/migrations/20260608000001_init.sql` (role enum), `web/src/lib/auth/guard.ts` (enforcement), `web/src/app/(console)/tokens/page.tsx`, `web/src/app/(console)/settings/page.tsx`, `web/src/app/api/auth/mfa/**`.

## Roles

`profiles.role` is a Postgres enum with **four** values: `admin`, `manager`, `member`, `viewer`. At the API-guard layer (`requireScope`, `web/src/lib/auth/guard.ts`) the only distinction currently enforced for a signed-in user is binary: **`viewer` is read-only** (any non-`read` action is rejected, `403`); `admin`, `manager`, and `member` are all treated as full-write today — there is no granular admin-vs-manager permission split enforced yet. If your operating model needs that split, it isn't there yet — track it as a gap, don't assume the label alone restricts anything.

A signed-in user's role is visible (read-only) on their own `/settings` page. There is no console UI to change *another* user's role — see [`docs/runbooks/user-provisioning.md`](../../docs/runbooks/user-provisioning.md) for how role assignment is actually done today (direct `profiles` row, by whoever has Supabase project access).

## PAT minting, scopes, and revoking

`/tokens` is a self-service page for **your own** scoped Personal Access Tokens (Bearer `npm_…`) — used by the CLI, the MCP server, or any external script. Minting a token:

- Names it and lets you pick from the scope list: `project:*`, `task:read`, `task:write`, `task:delete:request`, `task:delete:approve`, `risk:*`, `issue:*`, `clash:*`, `resource:*`, `budget:*`, `time:*`, `audit:read`.
- Shows the raw token **once**, at creation — it's stored server-side only as a SHA-256 hash, never logged, never retrievable again. Losing it means minting a new one.
- Token-authenticated callers use the admin client (RLS-bypassing) and are always filtered by `actor.workspaceId` server-side — a token can never reach outside its own workspace regardless of scope.

Revoking a token (also on `/tokens`) sets `revoked = true` immediately; a revoked token's calls start failing scope checks on the next request. There is no separate "disable" state — revoke is the only off switch, and it's not reversible.

## MFA

`/settings` hosts TOTP-based MFA enroll/verify/disable (`/api/auth/mfa`, `/api/auth/mfa/enroll`, `/api/auth/mfa/verify`, `/api/auth/mfa/disable`) — a user secures their own login with an authenticator app; there's no admin-forced MFA policy today.

## Seat provisioning

Adding a new person to the workspace — creating their login and assigning a role — is **not** a console flow in this build. It's an ops-level action performed against Supabase directly. See [`docs/runbooks/user-provisioning.md`](../../docs/runbooks/user-provisioning.md) for the real, current mechanism, and its pointer to the planned link-based invite flow.

## Where to go next

- The real provisioning mechanism, step by step → [`docs/runbooks/user-provisioning.md`](../../docs/runbooks/user-provisioning.md)
- Standing up a fresh workspace with its own slug/name and first admin → [`CUTOVER/01-INSTALL.md`](../../CUTOVER/01-INSTALL.md) (first-admin bootstrap section)

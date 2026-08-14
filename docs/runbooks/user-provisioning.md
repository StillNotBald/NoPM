# User provisioning — seats and roles

**Status: ACTIVE** (describes the real, current mechanism) — the invite-flow section below is **PLANNED**, not shipped.

## The real mechanism today

There is no self-serve signup and no console "invite a teammate" flow in this build (verified — no `/api/**` route or console page creates another user's login; `web/src/app/(console)/settings/page.tsx` only reads/writes the *signed-in* user's own MFA state, and `/api/me` is read-only). Adding a person to a workspace today is a two-step, ops-level action performed by whoever holds `SUPABASE_SERVICE_ROLE_KEY` access (typically via a script run against `web/.env.local`, the same pattern `web/scripts/bootstrap.mjs` and `web/scripts/seed-members.mjs` already use):

1. **Create the Supabase Auth user.** `db.auth.admin.createUser({ email, password, email_confirm: true })` via the Supabase service-role admin client — either through a small script (see `seed-members.mjs` for the exact pattern) or the Supabase dashboard's Auth → Users → Add user.
2. **Assign workspace + role.** Upsert a row in `profiles`: `{ id: <auth user id>, workspace_id: <target workspace>, role: 'admin' | 'manager' | 'member' | 'viewer', display_name, email }`. This row is what makes the login a member of a specific workspace — a Supabase Auth user with no matching `profiles` row can sign in but gets `AuthError("No workspace profile for this user")` on any API call (`web/src/lib/auth/guard.ts`).

`role` is a Postgres enum: `admin`, `manager`, `member`, `viewer` (`web/supabase/migrations/20260608000001_init.sql`). As documented in [`user-manual/admin/01-workspace-admin.md`](../../user-manual/admin/01-workspace-admin.md), the API guard today only enforces `viewer` = read-only; `admin`/`manager`/`member` are functionally identical at the enforcement layer.

There is no email actually sent as part of this today — Resend stays demo-mode per the constitution (`CLAUDE.md` Do-NOT-build). The new user must be told their email/password out of band.

## Removing a seat / offboarding

Also ops-level, not a console flow: revoke the person's PATs (`/tokens`, or directly against `api_tokens.revoked = true`), then either delete or disable their Supabase Auth user (dashboard) — there is no soft-disable on `profiles` today (no `deleted_at`/`disabled` column verified in the migrations). Deleting the `auth.users` row cascades to `profiles` and `user_mfa` (both reference `auth.users(id) on delete cascade`).

## PLANNED — link-based invite flow

The owner-resolved direction (`requirements/devops-wave1/README.md`, "Onboarding — two tracks") is a **link-based invite** (no email dependency, audited + revocable) as part of a first-run onboarding wizard: workspace → invite → optional sample project. This is explicitly **not yet built** — it lives in the feature-track PRD round referenced there, not this devops wave. Do not describe it as available; this section exists so the gap is a known, tracked gap rather than a silent one.

→ Source of the decision: [`requirements/devops-wave1/README.md`](../../requirements/devops-wave1/README.md), "Onboarding — two tracks" section.

## Where to go next

- Role enforcement details and PAT scopes → [`user-manual/admin/01-workspace-admin.md`](../../user-manual/admin/01-workspace-admin.md)
- Standing up a whole new workspace (not just a seat) → [`CUTOVER/01-INSTALL.md`](../../CUTOVER/01-INSTALL.md) first-admin bootstrap section

# UC-19 · Invite and onboarding

**Goal:** Bring a new person into the workspace with a real login tied to a real work identity, and get a brand-new workspace to its first project/task/audit-receipt/agent-connection/second-teammate without decision overload.

**Actors:** Admin / manager session (creates and revokes invites), new Team member (accepts the invite, becomes a real login).

**Preconditions:** The inviting actor is signed in as admin or manager (invites are user-session only; a token actor gets `403` "Invite management requires an admin/manager session").

**Trigger:** A workspace needs a second person (four-eyes deletion approvals need a second, different person — a solo workspace can request a deletion but never approve one), or a brand-new workspace has zero projects.

## Main flow — link invite

1. Create: `POST /api/invites` (admin/manager session). Role-escalation cap (D5): the invite's `role` must be ≤ the creator's own rank (`viewer < member < manager < admin`) — `422` if exceeded, so only an admin can mint another admin. Token prefix `npi_`; `expires_at` = now + 7 days; `invite_url` is returned **once**.
2. List/revoke: `GET /api/invites` (`?status=` filter; status is **derived** — `pending|accepted|revoked|expired` — never a stored column), `POST /api/invites/{id}/revoke` (`422` if not pending). Inviting an email that already has an account is `409` `account_exists` ("This person already has an account").
3. Accept: `POST /api/invites/accept` — public, unauthenticated, rate-limited 10/min per IP (no actor exists yet to key the normal per-workspace limiter on). Body: `{ token, password (>=12 chars), display_name }` — no email field; the invite's own email is always used. It creates the auth user **first**, then calls the atomic `nopm_accept_invite` RPC, which writes `profiles` + `resource_members` (bridged via `profile_id`, the same unified-identity rule as R-44) + marks the invite + writes **two** audit rows, all in one transaction. No session is returned — the new user signs in via `/login` afterward.
4. Anti-enumeration: not-found, already-used, revoked, and expired **all** return the identical uniform `422` from the API (never a distinct `404`) — deliberately, so a caller probing tokens can't distinguish "doesn't exist" from "already used." The public `/invite/{token}` page keeps distinct friendly copy for the human reading it, an intentional asymmetry between the API's anti-enumeration posture and the UI's helpfulness.
5. If RPC failure happens after the auth user was already created, the route best-effort deletes the orphan auth user (failure-injection unit-tested); any residual half-state fails closed at login with "No workspace profile," never a partial silent success.

## Main flow — first-run wizard and getting-started checklist

1. The first-run wizard mounts only when the workspace has zero projects **and** the caller can write (viewers keep the plain empty state). Four steps: welcome → first project → first task → done, linking onward to `/tasks` and `/tokens#connect-agent`. Every write in the wizard goes through the **existing public APIs**, so no new privileged path exists just for onboarding. Dismissible and resumable via a whitelisted `onboarding` preferences key, persisted only for non-demo identities.
2. `/start` ("Getting started," also in the account menu and command palette) is a 5-step, data-driven checklist computed from real workspace counts: create your first project, add a task and move it on the board, see the audit receipt in Trust Center, connect an AI agent (mint a token), invite a teammate. Role-aware: viewers see read steps only; write steps for a viewer say "ask your workspace admin." Includes a copy-paste CLI/curl quickstart verified against `cli/`.
3. The sidebar starts in **Essentials** mode (7 core modules) for brand-new accounts and the demo login; "Show all modules" is one click away; nothing is hidden permanently, and the active route always renders even if it's outside Essentials (a deep link never lands on an invisible page).

## Alternate and exception flows

- **A token actor tries to create/list/revoke an invite** → `403` (invites are user-session only).
- **Role escalation beyond the creator's own rank** → `422`.
- **Accepting an invalid/expired/already-used/nonexistent token** → uniform `422`, no information leak about which case it was.
- **Wizard abandoned mid-way** → leaves valid partial data (e.g. a project with no task yet); nothing rolls back.

## Postconditions

- `invite.created`/`invite.revoked` audit rows on the admin side (the code's spelling); on accept, two audit rows written atomically with the profile/membership creation (exact action strings `[UNVERIFIED]`, both written inside `nopm_accept_invite`).
- The new person is a full `profiles` + `resource_members` row, immediately assignable to tasks and allocatable to capacity — one identity across login, assignment, and cost from the moment they accept.

## Reporting and evidence

- The Settings page's Invites card shows every invite's derived status.
- The `/start` checklist and the dashboard's Governance Tour (R-77) both give a demo visitor or new admin a guided path through the same governed surfaces this catalogue documents, rather than a separate "demo mode."
- Diagram: [`invite-onboarding-flow.html`](../processes/invite-onboarding-flow.html).

## Update 2026-10-17 — journey-audit fixes

- **Accepting is retry-safe.** A lost response or a double click no longer strands a half-created login; repeating the accept finishes the job.
- **Shared demo login.** It cannot create invites (`403` `demo_restricted`).
- **Leavers.** Removing a person is an operator task, not a button: see the leaver procedure in [`docs/runbooks/user-provisioning.md`](../runbooks/user-provisioning.md) (revoke their tokens, ban the login, set the role to viewer). A token also stops working by itself if the creator's profile is removed. Their calendar feeds keep working (decision 9) until an admin revokes them.
- **Two-step.** Turning two-step off needs a current code or an unused backup code (`POST /api/auth/mfa/disable` with `{ code }`), and enrolling while it is on is `409` `mfa_already_enabled` (R-116).

## Update 2026-10-18 - common-pattern answers

- An expired invite is renewed with `POST /api/invites/{id}/renew` (422 `not_expired` otherwise; new life 7 days; audit `invite.renewed`). A manager cannot renew or revoke an invite an admin created (403 `admin_created`).
- Accepting with an email that already has an account says "This email already has an account. Ask them to sign in instead." (`account_exists`). A removed member who is invited again is restored with the same record (`restored: true`; the role is capped by the inviter's rank, 422 `role_escalation`).
- Two-step is required for admins and managers after a 14-day grace (decision 22). Enrolling twice within 60 minutes returns the same pending secret. People management (roles, leaving, restore, two-step reset) is in the console People page and `/api/members`.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

## Traceability

- R-IDs: R-75 (first-run wizard + link invites with unified identity), R-78 (progressive-disclosure onboarding: Essentials sidebar, `/start`, page hints), R-44 (unified person identity), R-77 (governance tour).
- Key files: `web/src/app/api/invites/route.ts`, `web/src/app/api/invites/[id]/revoke/route.ts`, `web/src/app/api/invites/accept/route.ts`, `web/src/lib/governance/invite-accept.ts`, `web/src/app/invite/[token]/page.tsx`, `web/src/lib/onboarding/steps.ts`, `web/src/components/onboarding/first-run-wizard.tsx`, `web/src/app/(console)/start/page.tsx`, migration `20260815000039_invites.sql`.
- Tests: failure-injection unit test for the orphan-auth-user cleanup path; role-escalation cap unit tests.

## Open questions

- `[UNVERIFIED]` Exact audit action strings written inside `nopm_accept_invite`.

# 01 · Getting started (console operator)

**Status: ACTIVE** · Verified against `web/src/app/login/page.tsx`, `web/src/components/layout/sidebar.tsx`, `web/src/components/layout/app-shell.tsx`, and `web/src/app/(console)/my-work/page.tsx`.

## Signing in

NoPM's sign-in screen (`/login`) offers two paths:

1. **One-click demo** — the "Try the live demo →" button. It POSTs to `/api/auth/demo-login`, which signs you in server-side as the pre-seeded demo user and redirects to `/dashboard`. No password, no signup. This is the public entry point at stillnotbald.com — it drops you into a **single shared, writable demo workspace**, not a private sandbox. Anything you create or delete there is visible to (and mutable by) the next visitor. Don't treat it as a private test account.
2. **Email + password** — a normal Supabase Auth sign-in for a real login (`admin@stillnotbald.com` for the seeded demo admin, or whatever account a workspace admin provisioned for you — see [`admin/01-workspace-admin.md`](../admin/01-workspace-admin.md)).

There is no self-serve signup screen in this wave — every login is either the shared demo or an account a workspace admin created (see [`docs/runbooks/user-provisioning.md`](../../docs/runbooks/user-provisioning.md) for how that's actually done today).

## The console shell

Once signed in you land on a persistent shell (sidebar + top bar) that every console page renders inside. The sidebar groups pages into five sections (`web/src/components/layout/sidebar.tsx`):

| Section | Pages |
|---|---|
| **Overview** | My Work, My Tasks, Dashboard |
| **Delivery** | Projects, Portfolio, Documents |
| **Registers** | Risks, Issues, Clashes |
| **Capacity** | Resources, Budget |
| **Governance** | Review, Change Control, Decisions, Approvals, Trust Center, Tokens, Email previews |

The top bar carries the project switcher, an account menu (Profile / Settings / Keyboard shortcuts / Support / Sign out), a theme toggle, and a trigger to open the **AI assistant** side panel (the BYOK assistant — see [`agents/README.md`](../agents/README.md)). The assistant is a panel that slides in over whatever page you're on, not a separate route.

## My Work

`/my-work` is the operator's landing page for "what needs me today" — it aggregates, in one page, across every project you're on:

- Your open tasks
- Risks you own
- Issues you own
- Deletion requests pending **your** approval
- A "hot" strip surfacing the most urgent items across all of the above

It is distinct from **My Tasks** (`/my-tasks`), which is a flat, single-purpose list of every open task assigned to you (joined to its project), sorted by due date — useful when you specifically want the task list and nothing else.

## Where to go next

- Creating and working a project → [`02-projects-and-tasks.md`](02-projects-and-tasks.md)
- Scheduling, dependencies, and lock → [`03-schedule-and-lock.md`](03-schedule-and-lock.md)
- Deletion requests, approvals, and the audit trail → [`04-approvals-and-trust.md`](04-approvals-and-trust.md)

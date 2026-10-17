# 00 · Your first ten minutes

**Status: ACTIVE** · Start here. Verified against `app/(console)/start/page.tsx`, `components/onboarding/start-checklist.tsx`, `components/layout/sidebar.tsx`, and `cli/README.md`.

The in-app equivalent of this page is `/start` — "Getting started" in the account menu and the command palette (⌘K). Both walk the same five steps; the checklist there tracks which ones your workspace has already done.

## The five steps

1. **Create your first project.** From `/projects`, click **New project**. Everything else — tasks, risks, the audit trail — hangs off a project.
2. **Add a task and move it on the board.** Open the project's **Board** tab, add a task, and drag its card to a new column. That drag is a real governed write: it produces the same `task.update` audit row you'd get from editing the field by hand.
3. **See the audit receipt.** Open **Trust Center** and find the row the drag just created. This is the whole thesis of the product in one screen: every mutation is exactly one immutable audit row.
4. **Connect your AI agent.** On the **Tokens** page, click **Mint token** and pick the agent preset scopes. A workspace admin does this step — if you're not one, ask them; the token is what lets your own agent call NoPM's API on your behalf.
5. **Invite a teammate.** Four-eyes deletion approvals need a second, different person who is an admin or a manager — a solo workspace can request a deletion but never approve one, and a member cannot approve. Invite from **Settings**.

## Before you start clicking: the sidebar starts small

The sidebar starts in **Essentials** mode — 7 core modules, not the full catalogue. The rest (Sprints, Mainline, Clashes, Timesheets, Change Control, Decisions, Email Previews, and more) are one click away: **Show all modules** at the bottom of the sidebar, or **Settings → Navigation & help**. Nothing is missing — it's just not on screen yet.

## Quickstart from your terminal

If you'd rather drive NoPM from a shell (or hand these to your own agent), mint a token on the Tokens page first, then:

```bash
nopm projects create --name "Website relaunch" --code WEB-01
nopm tasks create --project <projectId> --name "Cutover dry-run"
nopm audit --limit 5
```

`nopm --curl` on any command prints the equivalent curl call if you'd rather see the raw HTTP. Full command reference: [`cli/README.md`](../../cli/README.md).

## What you were NOT asked to decide

Deliberately absent from these first ten minutes, on purpose:

- **No hierarchy setup.** There's no workspace/program/portfolio structure to configure before you can create a project — you just create one.
- **No view setup.** Columns, grouping, and saved views all have sane defaults; configure them later from Settings if you want them, not before your first task exists.

## Where to go next

- Task fields, checklists, and acceptance criteria → [`02-projects-and-tasks.md`](02-projects-and-tasks.md)
- Scheduling, dependencies, and lock → [`03-schedule-and-lock.md`](03-schedule-and-lock.md)
- Approvals, four-eyes, and the Trust Center in depth → [`04-approvals-and-trust.md`](04-approvals-and-trust.md)

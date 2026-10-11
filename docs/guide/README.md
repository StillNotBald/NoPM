# Start here

NoPM is a project-management tool with a twist: you do not click around in it yourself. Your own AI agent (Claude, or any tool that speaks the Model Context Protocol) does the clicking for you, through a documented API. NoPM ships no AI model of its own. It is a governed record-keeper that any agent can drive, the way an agent might drive the `aws` or `stripe` command-line tools. Every change it makes is written to a permanent audit log, and any risky action (like deleting a task) needs a second person to approve it before it actually happens. That governance is built into the database and the API, not bolted on as a warning dialog in the browser.

## Who this is for

- **A project manager or team lead** curious what "AI-operated project management" actually looks like, without having to read code.
- **A developer** who wants to run NoPM for their own team, or wire their own agent up to it.
- **Someone evaluating NoPM for their organization** and deciding whether to try the demo, self-host it, or hire the owner for a guided setup.

You do not need to know Supabase, Next.js, or anything about databases to read these guides. Where a technical term shows up for the first time, it gets a one-line plain-English explanation.

## What NoPM covers

Underneath the agent-operated framing, NoPM is a fairly complete lite project-management tool. It tracks, per workspace: projects (with a status color, percent complete, and start/target dates), milestones, tasks (with typed statuses, checklists, and acceptance criteria), a Kanban board, a read-mostly Gantt view with dependency types and lag, risks, issues, cross-project clashes (schedule, resource, or dependency conflicts), a resource register with allocations and timesheets, and a budget register (planned, committed, actual, variance, burn). On top of that domain sit the governance features covered in guide 03: the audit log, scoped tokens, four-eyes approval, change control, and locking. None of this requires you to already run a bigger tool like Jira first. NoPM is meant to stand on its own, or sit beside whatever you already use.

## Three ways to use NoPM

1. **Try the hosted demo.** Visit the live site, log in with the built-in demo account (no password needed), and connect Claude to it over MCP (Model Context Protocol, the standard that lets an AI assistant call an app's tools). Nothing to install. See [01-try-the-demo-with-claude.md](01-try-the-demo-with-claude.md).
2. **Run it yourself.** NoPM's source code is public. Clone it, connect it to your own free Supabase project (Supabase is the hosted database-and-login service NoPM is built on), and you have your own private instance. See [02-run-it-yourself.md](02-run-it-yourself.md).
3. **Hire help.** The owner sells a paid implementation guide and takes paid change requests for anyone who wants NoPM adapted to their own workflow without doing the setup themselves. See [05-getting-help-and-paid-services.md](05-getting-help-and-paid-services.md).

## What makes NoPM different

Most project-management tools bolt permissions and audit trails onto the UI as an afterthought. NoPM does the opposite: the database itself refuses to let one person both request and approve a deletion, refuses to let a write happen without a permanent record, and refuses to hand out more access than a token's scopes allow. That means an AI agent can be given real, working access to your project data without your having to trust it not to do something destructive silently. Chapter 3 walks through exactly how that works, with real examples.

## The other guides

| Guide | What it covers |
|---|---|
| [01-try-the-demo-with-claude.md](01-try-the-demo-with-claude.md) | Step-by-step: log into the hosted demo, mint a token, connect Claude, and five things to try |
| [02-run-it-yourself.md](02-run-it-yourself.md) | Self-hosting in plain language: prerequisites, setup, first admin, connecting an agent |
| [03-how-governance-works.md](03-how-governance-works.md) | The audit log, scopes, four-eyes approval, change control, locking, and the Trust Center, each explained with a small real example |
| [04-for-developers.md](04-for-developers.md) | Repo map, the API contract, how to add an endpoint or an MCP tool the governed way |
| [05-getting-help-and-paid-services.md](05-getting-help-and-paid-services.md) | Free vs. paid support, what the owner will and will not build, the license |
| [06-faq.md](06-faq.md) | Answers to the questions a newcomer usually asks first |
| [../ROADMAP.md](../ROADMAP.md) | What's shipped, a menu of paid modules someone could sponsor or hire to build, what's not planned and why, and how to ask for something new |

## A word about the live demo

The hosted demo at stillnotbald.com is meant for looking and playing, not for storing anything you care about. Demo data gets reset periodically, and there is no uptime guarantee on it. If you want a stable instance for real use, run your own (guide 02).

## A word about the source code

NoPM's code is public so you (or your agent, or an implementer you hire) can read exactly how any of this is enforced, rather than taking a marketing claim on faith. If a claim in these guides ever seems to disagree with what the running app actually does, trust the app and the code. These guides describe the product as it existed when written, and file a correction if you find a gap.

## A short glossary

A few terms come up across every guide in this folder:

| Term | Plain-English meaning |
|---|---|
| **MCP (Model Context Protocol)** | An open standard that lets an AI assistant call an application's tools directly, instead of a person copy-pasting between a chat window and the app. |
| **PAT (Personal Access Token)** | A password-like key, scoped to specific permissions, that an agent or a script uses to authenticate to the API instead of logging in as a person. |
| **Scope** | A specific permission, written as `resource:action` (e.g. `task:write`), that a token either has or doesn't. |
| **Four-eyes / maker-checker** | A rule that the person (or token) requesting a risky action can never also be the one who approves it. |
| **Audit log** | A permanent, unchangeable record of every action taken in the system. |
| **Supabase** | The hosted database-and-login service NoPM is built on top of. |
| **Workspace** | The top-level container for one organization's data in NoPM. Projects, tasks, and everything else live inside exactly one workspace, and workspaces can never see each other's data. |

## If something in a guide doesn't work

These guides were written against a specific snapshot of the running app and its documentation. Software changes. If a step doesn't match what you see on screen, check the linked source document or file (each guide points at the real README or source file behind its claims) before assuming you've done something wrong. If you find a real gap, that's exactly the kind of thing worth an issue on the repository.

## Quick answers before you start

- **Do I need to pay for anything to try this?** No. The hosted demo and self-hosting are both free; only the implementation guide and custom change requests are paid.
- **Do I need my own AI subscription?** To use the demo with Claude, yes, you need a Claude account capable of adding an MCP connector. NoPM itself charges nothing for the connection.
- **Is there a mobile app?** No. NoPM is a web app and a set of agent-facing surfaces (CLI, MCP, API). It works in a mobile browser but isn't a native app.

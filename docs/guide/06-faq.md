# Frequently asked questions

## Does NoPM include an AI?

No. NoPM ships no language model of its own. It's a governed API and a browser UI. You bring the AI, whether that's Claude or any tool that speaks MCP (Model Context Protocol) or can call a REST API with a Bearer token, and NoPM enforces the rules around what that AI is allowed to do.

## Is my API key safe if I use the BYOK assistant?

The in-app BYOK ("bring your own key") assistant lets you paste your own OpenAI, Anthropic, Google, or OpenRouter API key so NoPM's built-in chat panel can use it. That key is encrypted at rest (AES-256-GCM, an industry-standard encryption method) and is never returned by any API endpoint once saved. You can't fetch it back out, even as the person who set it. The assistant itself never gets a broad, standing credential to your workspace: it's issued a fresh, narrowly scoped token for each turn of the conversation, and that token structurally cannot hold an approval or admin scope.

## Can I use NoPM commercially?

Yes. NoPM's source code is licensed under Apache License 2.0, which explicitly permits commercial use, including selling products built on it, with no royalty owed and no permission needed. See the license paragraph in `05-getting-help-and-paid-services.md` for the details and the one carve-out (the "NoPM" name and branding aren't covered by the code license).

## Is everything in NoPM open source, or is some of it held back?

Everything in the repository is open source: every module, the full API, the CLI, the MCP server, all of it. Nothing in the code is a paid, locked-away tier. What the owner sells is services on top of the open-source code: a paid implementation guide, paid change requests, and optionally hosted setup or team training. See `05-getting-help-and-paid-services.md` for the full breakdown.

## What happens to data in the hosted demo?

It gets reseeded and wiped periodically and is shared with every other visitor at the same time, since everyone who clicks "Try the live demo" lands on the same demo account. There is no uptime guarantee on the hosted demo. Don't put anything in it you'd be upset to lose or have someone else see, and never enter real client data, real email addresses, or real payment details. If you want private, durable data, run your own instance (see `02-run-it-yourself.md`).

## Does NoPM run on Windows?

Yes. NoPM was developed on Windows; its CI runs on Linux. Both work.

## Why doesn't NoPM have threaded comments or notification threads?

It's a deliberate scope decision, not an oversight. NoPM already has a notification center (an in-app bell plus a "My Work" hub) fed from real governed events, but a full comment-thread system is a large enough feature, with its own moderation, mention, and permission questions, that it's treated as "ask first" rather than something to build speculatively. If you need it for your own use, that's exactly the kind of thing a paid change request (see `05-getting-help-and-paid-services.md`) exists for.

## Can I self-host it?

Yes, in the way most people mean it: clone the repo, connect your own free Supabase project, and run it (see `02-run-it-yourself.md`). A deeper form of self-hosting, replacing Supabase itself with your own Postgres-based infrastructure, is documented in `docs/SELF_HOSTING.md` but is explicitly a documented shape, not a ready-to-run script; no `docker-compose` file ships in this repository for that path.

## What happens if I lose an access token?

Nothing recoverable. Tokens are shown to you exactly once, right after minting, and stored on NoPM's side only as a one-way hash (so even the operator of the instance can't recover the raw token). Mint a new one and revoke the old one from the Tokens page.

## Does NoPM actually send emails?

No, by design. Invites, notification previews, and similar flows render what an email *would* look like, but nothing is actually sent over the shared/demo instance. It's a deliberate "demo mode" choice so invite links don't accidentally create real accounts or spam anyone during a demo.

## Is NoPM multi-tenant? Could I see another company's data?

Each workspace is isolated: every table in the database carries a workspace id, and every query is filtered by it, both by the database's own row-level security for logged-in users and by explicit filters in the API code for token-based (agent) callers. It's covered by an automated workspace-isolation test. NoPM is one workspace per account by design, not a shared multi-company database with visibility controls layered on top.

## What happens if I ask my AI agent to delete something?

It depends what it is. Tasks and projects go through four-eyes approval: the agent can request the deletion, but a separate person or differently-scoped token has to approve it before anything is actually removed (see `03-how-governance-works.md`). Milestones, risks, and issues are deleted immediately, with just an audit row recording it. There's no undo for those today.

## Does NoPM support SSO or OAuth login?

Not today. It's on the "ask first" list, a real feature request, not something ruled out, but big enough to need its own scoping conversation before committing to build it.

## What's the difference between the CLI, MCP server, and BYOK assistant?

All three do the same underlying thing, call NoPM's REST API with a scoped Bearer token, through different front doors. The `nopm` CLI is a terminal command for a human or a script to run directly. The MCP server is the bridge an AI assistant like Claude uses to call NoPM's API as a set of tools. The BYOK assistant is an in-app chat panel that uses your own pasted API key to do the same thing, without leaving the browser. None of the three holds any special privilege the others don't; they're all bounded by whatever scopes their token carries.

## Can two different AI agents work in the same workspace at once?

Yes. Mint each one its own scoped token. Every audit row records which specific actor (human or token) made a given change, so even with multiple agents active you can always tell which one did what.

## What happens when I hit a rate limit?

You get a `429` response with the error code `rate_limited`, and the attempt itself is written to the audit log so a pattern of hitting the limit is visible, not a silent failure. The limiter is designed to fail open (never block traffic) if its own infrastructure has a problem, but fails closed and loud on an actual limit being hit.

## Is NoPM affiliated with Anthropic or Claude?

No. NoPM is an independent, portfolio project built by its owner. It supports connecting Claude (or any MCP-capable AI) as a client, the same way it would support any other agent. It isn't produced or endorsed by Anthropic.

## How is NoPM different from Jira, ClickUp, or similar tools?

NoPM isn't trying to replace those tools or match their full feature set. It positions itself as a lighter, governed record that sits beside your existing tools, with its differentiator being that the audit trail, access scopes, and approval rules live in the data and API layer itself, enforced by the database, not just suggested by the interface, which matters specifically when an AI agent, not only a human, has write access to your project data.

## Where do I report a security issue?

See `docs/SECURITY.md` for the private reporting channel and what's in scope. Please don't open a public issue for a security report, and please don't stress-test the live hosted demo beyond what's needed to demonstrate a specific issue.

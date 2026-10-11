# Product

*Working product brief in planning voice. For reader-facing documentation see `docs/guide/`.*

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: employers / technical evaluators** — a hiring manager, staff engineer, or investor assessing the builder through the artifact. They arrive cold at the landing or case study, decide within minutes whether the governance thesis is real, and may clone the repo to check the claims. (Confirmed 2026-08-13.)
- **AI agents** — Claude Code / Cursor / any MCP client driving the product through the REST API, CLI, or MCP server with a scoped token. Agents are first-class operators, not a gimmick.
- Secondary: investors/grant evaluators (e.g. a startup-grant pitch) and OSS developers reading the public repo.

## Product Purpose

A lite, API-first project-management tool that a user's own AI agent operates — like the `aws`/`supabase` CLIs, but for project governance. NoPM bundles no LLM. It exists as a live-hosted proof of the thesis: *"I build the systems that make unclear requirements impossible."* Success = an evaluator (human or agent) can verify every governance claim against the running system, and a pilot team can actually run their portfolio in it.

## Positioning

Three properties competitors can't truthfully claim simultaneously: (1) **agent-operable** — every action is a documented REST endpoint with scoped `resource:action` tokens, OpenAPI, llms.txt, CLI, and MCP; (2) **institutional governance in the data layer** — exactly one immutable audit row per mutation (fail-closed), four-eyes deletion enforced in scope + API + DB CHECK, even the service key can't rewrite history; (3) **the governed triangle** — timeline, resource, and budget changes pass one audit and sign-off gate in a single governed model (over-allocation → clash; spend → EVM variance; locked timeline → rebaseline sign-off); it is not a scheduler, a timesheet system, or an ERP.

### Complement, not replace

NoPM does not ask a team to give up Jira, Slack, or Teams. It is the governed record beside them: every change writes an immutable audit row, deletions require a second approver (four-eyes), and agents act only through scoped, ephemeral tokens. Feature parity with those tools is deliberately not the goal.

## Operating Context

- Live at stillnotbald.com (Vercel + Cloudflare; Supabase Postgres/Auth/RLS).
- Cold visitors enter via the landing's "Try the live demo" (≤2 clicks, seeded workspace, shared viewer identity — per-visit fresh assistant chats, no cross-visitor persistence).
- Operators work in the console (dashboard, Kanban, Gantt, registers, Trust Center); agents work over HTTP with PATs.
- The repo itself is a public exhibit: requirements register + RTM, sprint-log receipts, ADRs, generated proof metrics, checked-in governance gates.

## Capabilities and Constraints

- 8 modules (Workspace→Project→Milestone→Task, Risk, Issue, Clash, Resource, Budget) + governance backbone + Trust Center + deck export + BYOK assistant + notification center. 54 R-IDs tracked in `requirements/`.
- Stack is locked (ask-first): Next.js 16, TypeScript, Tailwind v4, shadcn-style primitives, Supabase. Approved libs listed in CLAUDE.md; nothing else without asking.
- Do-NOT-build list (CLAUDE.md): real email send, OAuth/PKCE, custom fields, automations, comment threads, any bundled LLM.
- Terminology: maker/checker, four-eyes, RAG status, clash, rebaseline, PAT, workspace. Task statuses are `backlog|unstarted|started|completed|canceled`.
- Undecided: the Mainline timeline 3-lens UI (design-approved, parked); Playwright UAT depth.

## Brand Commitments

- **Visual world (BINDING, owner-updated 2026-08-13):** terminal-light — white/near-black canvas, ink text, **Fluent blue `#0078d4` single accent** (owner retheme 2026-08-13; replaced terminal-green), JetBrains Mono for technical text, shadcn-style primitives, the traffic-light terminal motif. Bolder work happens WITHIN this world (composition, type scale, motion, motif) — never a new palette.
- Name: NoPM. Domain: stillnotbald.com. Voice: a working engineer's — concrete mechanisms, no hype, terse empty states.
- Sanitization is a brand commitment: no real client/stakeholder names in tracked files, ever.

## Evidence on Hand

- Real: the live deployment; generated proof metrics (`web/src/lib/metrics.gen.json` — R-IDs/tests/endpoints, CI-checked); the immutable audit trail itself; RTM + sprint logs + 8 ADRs; 533-test suite; public OpenAPI + llms.txt.
- Absent (must not be fabricated): testimonials, customer logos, usage numbers, pricing, benchmarks. The pilot client may not be named or implied in public surfaces.

## Product Principles

1. **Governance is invisible in flow, provable in audit** — operators never feel the controls; the Trust Center shows them.
2. **The API is the product; every surface (UI, CLI, MCP, assistant) is a client of it** — no privileged paths.
3. **Every claim is machine-verifiable** — metrics generated, contracts drift-tested, RTM CI-gated; if a number can't be verified, it isn't shown.
4. **Agents are operators** — anything a human can do without approval authority, an agent with the right scope can do, audited identically.
5. **Lite is a feature** — depth in the governance spine, restraint everywhere else.

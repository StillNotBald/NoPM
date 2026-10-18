# Roadmap

This page says what NoPM has shipped, what could be built as a paid module if someone wants to sponsor or hire for it, what is deliberately not planned, and how to ask for something that is not here.

## Shipped

Everything described here is in the repository today, not a promise. The canonical, requirement-by-requirement list is [`requirements/REQUIREMENTS.md`](../requirements/REQUIREMENTS.md), with each row traced to code and tests in [`requirements/TRACEABILITY.md`](../requirements/TRACEABILITY.md). In short: the governance backbone (immutable audit log, scoped tokens, four-eyes approval, locking, change control), all eight PM modules (projects, milestones, tasks, risks, issues, clashes, resources, budget), the Trust Center, the REST API with OpenAPI and `llms.txt`, the `nopm` CLI, a native MCP server, a BYOK governed assistant, and the console UI around all of it.

## Backlog

Owner decisions of 2026-10-17 put these items in the backlog. Each one is deferred; none is scheduled.

- **Lark live-tenant test.** Run the Lark / Feishu adapter against a real tenant, including card callbacks over the long connection, which are unverified. The owner setup checklist is [`docs/runbooks/lark-first-live-test.md`](runbooks/lark-first-live-test.md). R-99 stays PARTIAL until this is done.
- **CDN caching of the public pages** (approved 2026-10-17, started, not finished). Serve `/` and `/case-study` from the CDN without adding `'unsafe-inline'` to the CSP: a static root layout, plus an external before-paint appearance script.
- **Hour logging removed (owner decision 18, 2026-10-17).** Time entries and weekly timesheets are gone from the product; the tables and rows are kept, and budget actual is expenses only. Bringing it back means reverting the removal; see `CUTOVER/09-REMOVE-HOUR-LOGGING.md`.
- **Owner questions left open by the journey audit.** The Priority 1 questions (21 when written; the "who may approve" one is now answered) such as who may lock, rebaseline approvers, removed people's access and in-app role change, deferred change requests, assistant deletion requests, and the rest wait for an owner answer in [`journeys/OPEN-QUESTIONS.md`](../journeys/OPEN-QUESTIONS.md) ("Priority 1", full list in `journeys/DECISIONS-2026-10-17.csv`). "Who may approve" is settled by decision 16 (admins and managers only, on every channel; ADR 0014). Decision 17 (members log only their own hours) is awaiting the owner's confirmation.

### Common-pattern answers (2026-10-18)

Shipped: decisions 19 to 25 and the common-pattern defaults for work records, people, tokens and integrations (ADR 0015, R-120 to R-126). Still open: file versioning and the 30-day clean-up job for replaced files (Q-GOV-22), and the 14-day session length, which is a Supabase dashboard setting (Q-ACC-20).

## Paid-module menu: sponsor or hire to build

None of these exist yet. They are a menu of options for a future paid tier, not a commitment or a timeline. If one of these would help your organization, you can sponsor its development or raise it as a paid change request. See [`docs/guide/05-getting-help-and-paid-services.md`](guide/05-getting-help-and-paid-services.md). No prices are listed here; quote on request.

- **SSO Connector Pack.** SAML or OIDC login wired to NoPM's existing identity model, plus an admin console for identity-provider configuration and a migration path from password and TOTP login. What exists today: password login with TOTP multi-factor authentication. Rough size: 15 to 25 days for one identity provider.
- **Multi-Workspace Admin Console.** An organization-level view across workspaces: seat management, cross-workspace billing hooks, and org-wide policy defaults. What exists today: workspaces are fully isolated by row-level security, but there is no console above them. Rough size: 20 to 30 days.
- **Board-Pack Reporting Pack.** A scheduled, multi-project executive deck, emailed automatically, plus report templates beyond the current single-project export. What exists today: on-demand single-project deck export to PPTX, PDF, or HTML, and a CSV export by entity. Rough size: 10 to 15 days.
- **DR and Backup Automation Kit.** A scripted point-in-time-recovery drill runner, scheduled logical dumps to a customer-owned bucket, and a one-command restore rehearsal. What exists today: the procedure is fully documented in `docs/DR_RUNBOOK.md`, but nothing runs it automatically. Rough size: 10 to 20 days.
- **Integration Bridge (Slack, Jira, or Teams).** Real two-way sync: a status change pushes to Slack, or a Jira issue creates and updates a linked NoPM task. What exists today: a one-way reference pointer (a task or project can name the upstream item it mirrors) with no sync or polling. Rough size: 15 to 25 days per platform.
- **Compliance Evidence Pack.** A one-click auditor packet: a themed document bundling audit-log excerpts, four-eyes decision trails, and access-review snapshots for a chosen date range. What exists today: the Trust Center's live audit stream, filters, and CSV export supply the raw data manually. Rough size: 8 to 12 days.
- **Hosted BYOK Vault.** Owner-managed key storage across many customer workspaces, with rotation and its own audit export. What exists today: each self-hosted or demo instance manages its own encrypted key, with no shared hosting layer. Rough size: 15 to 20 days plus ongoing hosting.
- **Priority Support or Retainer.** A guaranteed response time, a direct support channel, and a quarterly architecture review call. No build required; this is a services offering.

## Not planned

These are deliberately out of scope, not gaps someone forgot. Root [`CLAUDE.md`](../CLAUDE.md) calls them "ask first" for a reason: each one is either a large engine that does not fit a lite tool, or touches a rule the whole governance pitch depends on.

- **A bundled AI model or a shared API key for production use.** NoPM's whole design is that you bring your own agent and your own model access. Bundling one would contradict the product itself.
- **A custom-field engine.** Keeps the data model and the governance layer simple and auditable; a generic field engine is a large, ongoing maintenance surface for a lite tool.
- **An automations engine.** Same reasoning as above: a rules engine is a different, much larger product.
- **Threaded comments and notification threads.** Large surface area (moderation, mentions, read state) for a tool whose job is the governed record, not a chat product.
- **OAuth, PKCE, or SSO, by default.** Real, but scoped to a paid module (see above) rather than the open core, since it is orthogonal to governance and has real per-provider support cost.
- **Multi-tenancy beyond `workspace_id` plus row-level security.** The isolation model is a constitutional invariant; broadening it casually is exactly the kind of change that must not happen by accident.
- **Anything that weakens audit immutability.** No editable or deletable audit row, ever, for any reason, paid or not.
- **Anything that weakens workspace isolation.** No workspace can see another's data, even "just this once."
- **Anything that removes self-approval protection.** Every four-eyes flow requires a different approver than requester, structurally, not by convention.
- **Real outbound email send in the shared demo environment.** The demo login is shared and reset periodically; wiring real send onto it is an abuse vector, not a feature. Self-hosted deployments control their own email settings independently of this rule.

## How to influence it

Open a change-request issue on the repository (the "Change request" issue template) describing what you want and why. It can become a free contribution, a paid change request, or a redirection toward one of the paid-module options above, whichever fits. See [`docs/guide/05-getting-help-and-paid-services.md`](guide/05-getting-help-and-paid-services.md) for what a good request looks like and what will not be built regardless of payment.

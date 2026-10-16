# Getting help and paid services

Everything in this repository is open source: every module, every governance rule, the full API, the CLI, the MCP server. Nothing in the code is held back for paying customers. What the owner sells is services built on top of that code: a paid implementation guide, paid change requests, and optionally hosted setup or team training. This chapter draws that line plainly.

## Free help

- **Bugs and questions:** open an issue on the GitHub repository. This is the right place for "this doesn't work as documented" or "how do I do X."
- **Security reports:** see `docs/SECURITY.md`. Do not open a public issue for a security vulnerability; that document names the private reporting channel and what's in scope.
- **The documentation itself:** everything in this `docs/guide/` folder, plus the deeper technical docs it links to (`docs/SELF_HOSTING.md`, `web/mcp/README.md`, `cli/README.md`, the user manual under `user-manual/`), is free to read and reuse.

## Paid: the implementation guide

The free docs already in the repository (this guide folder, `docs/SELF_HOSTING.md`, `docs/DR_RUNBOOK.md`, the `user-manual/`, `cli/README.md`, `web/mcp/README.md`) tell you what NoPM is and how to point it at infrastructure that already works, whether that's the hosted demo or a from-scratch self-host of the documented shape. They do not walk a team through adopting NoPM as their actual system of record: role design for a real org chart, migrating existing data, running an agent rollout in production, or producing audit evidence for a real audit. That gap is what the paid implementation guide covers.

Outline, subject to change:

1. **Planning your rollout**, workspace structure, who gets admin vs. operator access, and what to migrate from your current tool.
2. **Deployment hardening beyond the default**, a verified, walked-through hardening pass beyond the free self-hosting guide: TLS termination choices, secrets management beyond `.env.local`, and a checklist for going from "documented shape" to "verified working" in production.
3. **Role and scope design for your org**, mapping a real org chart (PM, PMO lead, delivery lead, finance, exec sponsor, external agent) onto scope bundles and token presets, including where four-eyes pairs should sit so nobody can approve their own team's deletions.
4. **Governance policy mapping**, translating NoPM's built-in rules (audit immutability, maker-checker, workspace isolation, project-lock/rebaseline) into the language of governance frameworks your compliance team already recognizes.
5. **Setting up your first governed workflow**, projects, tasks, locking, and when to reach for a rebaseline versus just unlocking.
6. **Migrating from ClickUp, Jira, or spreadsheets**, a concrete field-mapping and import playbook, and what is lost in translation (NoPM has no custom-field engine, by scope decision).
7. **MCP rollout for a team**, token issuance policy per agent or person, least-privilege preset design, monitoring agent-driven writes, and what to do if an agent's token is compromised.
8. **Reporting and exports**, what's available out of the box (audit exports, CSV, deck export) and how to build the reports your stakeholders actually ask for.
9. **Producing audit evidence for a real audit**, pulling a real evidence packet from the Trust Center and the audit export endpoint for an actual audit cycle, and what language to hand an auditor.
10. **Customizing without forking your future**, what's safe to change in your own deployment versus what will make future updates painful to merge.
11. **Operational runbooks**, the buyer-specific version of backup, disaster recovery, and monitoring already documented in `docs/DR_RUNBOOK.md`: a filled-in drill log, your actual retention tier, your actual recovery-time measurement, run once with the owner present.
12. **Training**, a structured, role-by-role walkthrough with live questions and organization-specific examples, so new hires don't require re-purchasing the guide.

## Paid: change requests

If you want a feature or a change that isn't in NoPM today, you can raise a paid change request. In plain terms: you describe what you want, the owner scopes it, quotes it, and builds it (or explains why not).

**What to include when you raise one:**

- **Who's asking**, your name, organization, and how to reach you.
- **A one- or two-sentence summary** of what you want, in your own words.
- **Category**, bug fix, small enhancement, new integration, custom feature, or configuration change.
- **Which part of NoPM it touches**. This helps flag early whether it brushes up against one of the rules below.
- **Why it matters to you**, the business reason, not just the feature request.
- **Your desired timeline.**
- **What "done" looks like**, stated up front in your own words.
- **Your environment**, the hosted demo, your own self-hosted instance, or your own fork.

**What the owner will not build**, regardless of payment, because it would break the product's core promises:

- Anything that weakens **audit immutability**, for example, a way to edit or delete an existing audit log row, or a "soft delete" for audit rows.
- Anything that weakens **workspace isolation**, for example, letting one workspace see another's data, even "just this once."
- Anything that would let a write happen **without an audit record**. Every mutation writes exactly one audit row, and that is enforced automatically, not just by convention.
- Anything that breaks **self-approval protection**. Every maker-checker flow in NoPM (task and project deletion, change-request decisions, timesheet approval, rebaseline sign-off) requires the approver to be a different person from the requester. A token counts as the person who minted it, so a token cannot approve a request its own person raised.
- A **bundled AI model** or a shared, non-BYOK API key for production use. NoPM's whole design is that you bring your own agent and your own model access; NoPM does not ship one.
- **Real outbound email sending in the shared/demo environment** (self-hosted deployments already control their own email settings independently of this rule).
- **A new hosting or infrastructure dependency without a written trade-off**, consistent with how the project already documents the reasoning behind its existing dependencies before adding one.

Some other categories are "ask first" rather than flatly off the table, for example a custom-field engine, an automations engine, threaded comments/notifications, or SSO, because they're large enough to need scoping and a real conversation before committing to build them. Raising a change request is exactly that conversation.

**How to raise one:** open a GitHub issue using the "Change request" issue template (not the plain bug report template) and fill in the fields it asks for; that's the same intake shape as the fields above. Say plainly whether you expect this to be a paid engagement, so it gets triaged correctly instead of as a free-tier bug report. For a private conversation about pricing, scope, or timeline, use the contact details on the repository owner's GitHub profile. If you're running your own fork or self-hosted instance and want your landing page's "Raise a change request" link to point somewhere other than this repository's issue tracker, set `NEXT_PUBLIC_CONTACT_URL` in your `.env.local` to your preferred URL; leaving it unset keeps the default GitHub issue chooser.

**What a good change request looks like:** describe the outcome you want, not the implementation. "I need my finance team to see budget variance across all projects on one screen" is a better starting point than "add a new database table." The owner scopes it against NoPM's existing data model and governance rules, quotes an estimate, and only then builds it. If what you're asking for would weaken one of the constitutional rules above, expect a counter-proposal for how to get most of what you want without that trade-off, rather than a flat no with nothing offered in its place.

**Turnaround:** most requests get a first response within a few business days, with a scoped estimate to follow shortly after. Anything time-sensitive or blocking can be flagged as priority when you raise it. A new integration or a larger custom feature usually starts with a short, paid scoping conversation before either side commits to a timeline or a fixed price. That upfront scoping step is what makes the eventual quote a fixed price rather than an open-ended hourly estimate.

## The license, in plain language

NoPM's source code is licensed under **Apache License 2.0**. In practice, that means: you can use it, copy it, modify it, and even sell products built on it, for free, including commercially. You don't owe the owner anything and you don't need permission. The two obligations that come with that freedom are: you must keep the license and copyright notices intact in any copy you distribute, and if you modify a file, you should note that you changed it. Apache-2.0 also includes an explicit patent grant, which some organizations' legal teams prefer over other permissive licenses for exactly that reason. It does not grant you rights to the "NoPM" name or branding; that's a trademark-style consideration kept separate from the code license.

## Contributing instead of paying

If you'd rather contribute a fix or a feature yourself than pay for it, that's welcome too. NoPM accepts contributions the same way many open-source projects do, through pull requests. The catch is that contributions go through the same discipline the codebase demonstrates on itself: every behavior change needs a matching entry in the requirements list (`requirements/REQUIREMENTS.md`) and its traceability record (`requirements/TRACEABILITY.md`), updated in the same commit as the change, and every mutation-producing change needs to keep writing exactly one audit row. See `docs/CONTRIBUTING.md` for the full ground rules before opening a pull request. It's a short read, and it exists precisely so a contribution doesn't get stuck in review over something avoidable.

## What "open source" does and doesn't mean here

Being open source means you can read every line of how NoPM enforces its governance rules. There's no hidden server-side check you have to take on faith. It does not mean the hosted demo at stillnotbald.com is a community-run project, or that the owner is obligated to accept every contribution or feature request for free. Free help and the source code are a genuine gift; the paid guide and change requests are how the owner is compensated for turning that gift into something ready for your organization specifically, without you having to become an expert in it first.

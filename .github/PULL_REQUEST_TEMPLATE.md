## What this changes and why

<!-- One or two sentences. Link an issue if there is one. -->

## Governance checklist

NoPM enforces its own rules in the data and API layer, not just by convention. Check what applies; leave unrelated items unchecked with a short note.

- [ ] Every new mutation writes exactly one audit row (`writeAudit`, fail-closed). No silent writes.
- [ ] Every query on a token-authenticated path is filtered by `actor.workspaceId` (token callers use the admin client, which bypasses RLS).
- [ ] Every new or changed endpoint requires a scope via `requireScope`, and the scope is the narrowest one that fits.
- [ ] Responses use the `{ data }` / `{ error }` contract with the correct HTTP status (401 auth, 403 scope, 404, 422 rule, 429 rate-limited).
- [ ] The matching row in `requirements/REQUIREMENTS.md` and `requirements/TRACEABILITY.md` is updated in this same commit.
- [ ] Tests are added or updated for the change.
- [ ] If a route was added or changed: the OpenAPI spec, `llms.txt`, and the MCP tool registry (`web/mcp/tools.mjs`) are updated to match.
- [ ] No secrets, tokens, or real client/stakeholder names are in this diff.
- [ ] `npm run test`, `npx tsc --noEmit`, and `npm run rtm:verify` all pass locally.

## Do not open a PR that…

These mirror the constitution's ask-first and will-not-build list (root `CLAUDE.md`, `docs/guide/05-getting-help-and-paid-services.md`). Open an issue first to discuss any of these before writing code:

- Weakens audit immutability (an editable or deletable `audit_log` row, a soft-delete for audit rows, or a bypass around the no-update/no-delete triggers).
- Weakens workspace isolation (lets one workspace's token or session read another's data).
- Adds a write path that is not wrapped by `writeAudit`.
- Adds a maker-checker flow where the requester can also approve their own request.
- Bundles an LLM or a shared, non-BYOK API key for production use.
- Wires up real outbound email send in the shared demo environment.
- Adds a new dependency, or a new hosting/infra dependency, without asking first.
- Builds a custom-field engine, an automations engine, comments/notification-threads, OAuth/PKCE/SSO, or multi-tenancy beyond `workspace_id` + RLS, without asking first.

If your change touches one of these, open an issue describing the goal before the PR, so it can be scoped or redirected before you spend time on it.

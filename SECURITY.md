# Security Policy

## Reporting a vulnerability

Email **hello@stillnotbald.com** with details and reproduction steps. You'll get an acknowledgment within 72 hours. Please don't open a public issue for security reports, and please don't test against the live demo at stillnotbald.com beyond what's needed to demonstrate the issue.

## Scope

- The NoPM application (`web/`), CLI (`cli/`), and MCP server (`web/mcp/`).
- The live deployment at stillnotbald.com (demo data only — but treat it gently).

## Security model (what to probe)

- **Workspace isolation**: token callers use the admin client, so every query must filter by the actor's workspace — a missing filter is a cross-tenant read. (`web/src/lib/auth/guard.ts`, workspace-isolation tests.)
- **Scope enforcement**: every endpoint requires a `resource:action` scope; the assistant's ephemeral token must never hold approve/admin/token scopes (machine-checked).
- **Audit immutability**: `audit_log` is append-only via Postgres triggers; a bypass is a high-severity finding.
- **Maker-checker**: self-approval of a deletion request must be impossible (scope + API guard + DB CHECK).
- **Secrets at rest**: PATs are SHA-256 hashed; BYOK provider keys are AES-256-GCM encrypted and never returned by any endpoint.

## Standing known items

- `image-size` (via `pptxgenjs`): upstream DoS advisories with no patched release. The vulnerable parsers are unreachable — NoPM's deck export feeds pptxgenjs data-driven charts/text only, never user-supplied image files. Tracked in `.github/workflows/ci.yml` (dependency-audit job comment).

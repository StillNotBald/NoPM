# Security Policy

## Reporting a vulnerability

Email **hello@stillnotbald.com** with details and reproduction steps. You'll get an acknowledgment within 72 hours. Please don't open a public issue for security reports, and please don't test against the live demo at stillnotbald.com beyond what's needed to demonstrate the issue.

## Scope

- The NoPM application (`web/`), CLI (`cli/`), and MCP server (`web/mcp/`).
- The live deployment at stillnotbald.com (demo data only — but treat it gently).

## Security model (what to probe)

- **Workspace isolation**: token callers use the admin client, so every query must filter by the actor's workspace — a missing filter is a cross-tenant read. (`web/src/lib/auth/guard.ts`, workspace-isolation tests.)
- **Scope enforcement**: every endpoint requires a `resource:action` scope; the assistant's ephemeral token must never hold approve/admin/token scopes (machine-checked).
- **Audit immutability**: `audit_log` is append-only via Postgres triggers; a bypass is a high-severity finding. Rows written directly by a Postgres RPC (`nopm_commit_task_deletion`, `nopm_commit_project_deletion`, `nopm_accept_invite`) carry the same `channel`/`request_id` provenance as rows written through `writeAudit` (R-84, migration `20260906000044_rpc_audit_provenance.sql`).
- **Maker-checker**: self-approval of a deletion request must be impossible (scope + API guard + DB CHECK).
- **Maker-checker scope (documented asymmetry)**: four-eyes deletion extends to projects as well as tasks; milestones/risks/issues remain single-step audit-only hard deletes by owner decision, not by omission (`requirements/devops-wave1/README.md`, Decision 3).
- **Document attachments**: the declared `mime_type` is normalized (browser-executable types such as HTML/SVG/XML/JS are stored as `application/octet-stream`), inline-rendered types (PDF, PNG, JPEG, GIF, WebP) are verified against the uploaded bytes on attach (422 on mismatch), and every other type is served with `Content-Disposition: attachment` (`web/src/lib/documents/storage.ts`, `web/src/app/api/documents/[id]/file/route.ts`).
- **Secrets at rest**: PATs are SHA-256 hashed; BYOK provider keys are AES-256-GCM encrypted and never returned by any endpoint.
- **MFA challenge at login (R-91)**: an account with TOTP/backup-code MFA enabled (`user_mfa.enabled`) must pass `POST /api/auth/mfa/challenge` before any other authenticated request succeeds — `requireAuth` (`web/src/lib/auth/guard.ts`) rejects a session actor with `401 "MFA required"` unless the request carries a valid `nopm_mfa` cookie (HttpOnly, Secure in production, `SameSite=Lax`), a base64url `{uid, exp, enr}` payload HMAC-SHA256-signed with a key derived from `NOPM_ENCRYPTION_KEY`, capped at 12h and never outliving the underlying Supabase session. `enr` binds the cookie to the account's current TOTP enrollment (`user_mfa.enrolled_at`); disabling or re-enrolling MFA changes `enr`, so a cookie issued before that change can never satisfy the new enrollment (it's also actively cleared on disable/verify as defense in depth). The challenge endpoint caps attempts at 5 failures per 10 minutes per user, writes its governance audit row *before* issuing the cookie (a failed audit write yields no cookie), and consumes a backup code via an atomic conditional update so two concurrent requests can never both succeed with the same code. The `(console)` layout's own pre-render redirect (`web/src/app/(console)/layout.tsx`) is fail-**closed**: most console pages read their data via direct SSR Postgres queries outside `requireAuth`, so a `user_mfa` lookup error there blocks the console render rather than allowing it through.
- **Browser hardening (ADR 0011)**: every response carries a CSP (`default-src 'self'`, Supabase-only `connect-src`, `frame-ancestors 'self'`, `object-src 'none'`), HSTS (prod), `nosniff`, `X-Frame-Options: SAMEORIGIN`, a strict referrer policy and a deny-by-default `Permissions-Policy`; `X-Powered-By` is stripped. Built by `web/src/lib/security/headers.ts` (unit-tested). Known step-1 gap: `script-src` still allows `'unsafe-inline'` (Next inline RSC payload) — a nonce-strict CSP is the tracked follow-up.

## Standing known items

- `image-size` (via `pptxgenjs`): upstream DoS advisories with no patched release. The vulnerable parsers are unreachable — NoPM's deck export feeds pptxgenjs data-driven charts/text only, never user-supplied image files. Tracked in `.github/workflows/ci.yml` (dependency-audit job comment).

## Update 2026-10-18 - common-pattern answers

- Token life: new personal access tokens default to 90 days and cannot exceed 365; the list reports `days_left` and `expiring_soon`.
- Two-step is required for admins and managers after a 14-day grace; session length 14 days is a Supabase dashboard setting (owner step, Pro plan).
- People removal bans the login, revokes the person's tokens and cancels their pending invites in one admin action (`DELETE /api/members/{id}`), and every role change, removal, restore and two-step reset is audited.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

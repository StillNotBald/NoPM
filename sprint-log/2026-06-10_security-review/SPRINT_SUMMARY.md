# Sprint Summary — 2026-06-10_security-review

**TL;DR:** Multi-agent security review (3 domains, adversarially verified + live DB probe) found a strong core with one real HIGH (rebaseline four-eyes) — fixed it plus all Mediums and the LOW hardening, in two verified passes.

## Declared goals
- "do security review" → audit + fix everything the review surfaces (user chose "fix everything").

## Method
3 parallel read-only agents (authz/IDOR/maker-checker · injection/secrets/XSS/CSRF/crypto · RLS/audit/secrets-at-rest), then **every material finding adversarially verified** by reading the exact code + a live `pg` probe (`pg_trigger`, `pg_policy`, `pg_proc`). Two agent over-claims corrected: the deletion-RPC "bypass" is blocked by `audit_log` INSERT RLS (downgraded to LOW), and the audit-immutability trigger is confirmed **enabled in prod**.

## Verified clean (held up)
No IDOR (every admin-client query workspace-scoped, CI-guarded) · deletion four-eyes sound · audit immutability active in prod · AES-GCM crypto textbook · BYOK key never leaks · no XSS/SSRF · full RLS, no `USING(true)` · private storage with path-validated signed URLs.

## Fixed
**HIGH-1 rebaseline four-eyes** (R-04): new `rebaseline:approve` scope (excluded from the assistant token) on signoff/apply + self-signoff/apply API guards + migration 0022 DB trigger. Functionally verified: requester self-signoff → `SELF_SIGNOFF` blocked.
**MEDIUM-1** TOTP secret AES-GCM encrypted at rest (enroll/verify, legacy-plaintext back-compat).
**MEDIUM-2** search `.or()` filter injection — `q` sanitized.
**MEDIUM-3** CR `status` removed from PATCH (transitions must go through audited `/decision`).
**LOW (migration 0023):** durable demo rate-limit (deny-all table + row-locked RPC); deletion RPC `revoke execute from public/anon/authenticated` + `search_path` (verified grants = postgres/service_role only); cookies pinned `SameSite=Lax`+`Secure`(prod); bare global `*` scope no longer mintable; demo checker token granted `rebaseline:approve`.

## R-IDs touched
- R-04 Control-Tower rebaseline → four-eyes hardened (scope + guards + DB trigger)
- R-05 MFA → TOTP secret encrypted at rest
- R-02 scoped PATs → bare `*` no longer mintable
- R-07 change-control → status forced through `/decision`
- R-24 BYOK assistant → durable rate-limit

## Files
- Doc: `docs/research/SECURITY-REVIEW-2026-06-10.md` (findings + remediation status).
- Pass 1 (`292d365`): scopes(+test), rebaselines signoff/apply, mfa enroll/verify, search, change-requests route/_schema, migration 0022.
- Pass 2: assistant/index.ts, supabase/server.ts, middleware.ts, scopes(+test), bootstrap.mjs, migration 0023.

## Tests / verification
- tsc 0 · 120 tests · build 47 routes · migrations 0022+0023 applied to prod · DB probes confirm trigger enabled + self-signoff blocked + RPC grants locked down + rate-limit table deny-all.

## Follow-ups / documented residuals
- `session_replication_role` audit bypass (service-role/superuser) — accepted.
- `assistant_credentials` ownership API-enforced over deny-all RLS — accepted.
- Mainline switcher shell remains the next feature build (design-approved, parked).

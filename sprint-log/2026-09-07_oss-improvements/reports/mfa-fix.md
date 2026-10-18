# R-91 MFA login challenge — fixes for verify-mfa.md

All 5 required fixes applied. `tsc --noEmit` clean, `vitest run` **1993/1993**
passing (up from 1976; +17: mfa.test.ts +5, guard.test.ts +12), `eslint`
0 errors on every touched file, `npm run build` clean (`/api/auth/mfa/challenge`
in the route manifest). No git commits made.

## Fix 1 — console layout fail-closed

`web/src/app/(console)/layout.tsx:16` now calls a new
`requiresMfaChallengeFailClosed()` instead of the old `requiresMfaChallenge()`.
Both live in `web/src/lib/auth/mfa.ts`, sharing one `cache()`d internal
`evaluateMfaChallenge()` (returns `"satisfied" | "required" | "error"`) so a
request never pays for more than one DB round trip regardless of which
variant is called:
- `requiresMfaChallenge()` (kept, fail-open: `=== "required"`) — no longer
  used by anything, kept only for reference/symmetry.
- `requiresMfaChallengeFailClosed()` (new, fail-closed: `!== "satisfied"`) —
  used by the layout. A lookup error now redirects to `/login?step=mfa`
  instead of rendering the console.

## Fix 2 — cookie bound to the enrollment

`web/src/lib/auth/mfa.ts`:
- New `computeEnrollmentBinding(enrolledAt: string): string` — first 16 hex
  chars of `SHA-256(enrolledAt)`. Bound to `user_mfa.enrolled_at`, not
  `totp_secret` ciphertext — the migration
  (`web/supabase/migrations/20260608000002_identity.sql:6-13`) has no
  `updated_at`/enrollment-id column, and `totp_secret` gets zeroed on
  disable (see Fix 2 addendum below), which would make a ciphertext-hash
  binding collide across accounts. `enrolled_at` is set to a fresh
  timestamp on every `enroll` call, including re-enrollment
  (`enroll/route.ts:30`), and is untouched by verify/disable/challenge — the
  most stable "this enrollment" identity available.
- `MfaCookiePayload` gained `enr: string`; `issueMfaCookie(uid, enr,
  sessionExpiresAt?)` and `verifyMfaCookie(value, uid, enr)` both changed
  signature (enr is now a required, checked field, alongside the existing
  `uid`/`exp`).
- `getMfaEnrollmentStatus(userId)` replaces `isMfaEnabledForUser` — one query
  (`select("enabled, enrolled_at")`) returning `{enabled, enr}` so callers
  never need a second round trip for the binding value.
- `web/src/lib/auth/guard.ts:73-82` (`assertMfaSatisfied`) now calls
  `getMfaEnrollmentStatus` and passes `enr` into `verifyMfaCookie` — still
  one query, as requested.
- `web/src/app/api/auth/mfa/challenge/route.ts:65-69,122-123` — select
  includes `enrolled_at`; `issueMfaCookie(actor.id, enr, sessionExp)`.
- Cookie cleared in **`disable/route.ts`** (after the DB update + audit,
  `store.delete({name: MFA_COOKIE_NAME, path: "/"})`) and **`verify/route.ts`**
  (enable path, same pattern) per the spec, as defense in depth alongside the
  `enr` binding itself.
- **Scope note**: `web/src/app/api/auth/mfa/route.ts` (the `GET` status
  endpoint) was **not** in my file scope, but it calls `verifyMfaCookie`
  directly and would not compile / would always report `satisfied: false`
  once the signature changed. I made the minimal necessary edit there
  (select `enrolled_at` too, compute `enr`, pass it through) to keep
  `tsc`/`vitest`/`build` green — flagging this deviation per your
  instructions.
- **Incidental bug found and fixed**: `user_mfa.totp_secret` is declared
  `NOT NULL` in the migration
  (`web/supabase/migrations/20260608000002_identity.sql:8`), but
  `disable/route.ts` was writing `totp_secret: null` — this would violate
  the DB constraint and 500 on every real call to `POST
  /api/auth/mfa/disable` (i.e. disable was likely completely broken in
  production, independent of anything in this fix set). Changed it to
  `totp_secret: ""` (still wipes the usable secret; `""` isn't a valid
  3-segment ciphertext so it falls to the raw-secret branch and fails TOTP
  verify, and this path is unreachable anyway once `enabled` is `false`).
  This was in my file scope (`disable/route.ts`) and directly adjacent to
  the cookie-clear fix I was already making there, so I fixed it rather
  than leaving a route I'd just touched still broken — flagging in case you
  want it split into its own line item.

## Fix 3 — atomic backup-code consumption

`web/src/app/api/auth/mfa/challenge/route.ts:99-119`. Replaced the
read-filter-write with:
```ts
.update({ backup_codes: remaining })
.eq("user_id", actor.id)
.contains("backup_codes", [codeHash])
.select("user_id")
```
(`backup_codes` is `text[]`, confirmed in the migration, so `.contains` maps
to Postgres `@>` array containment — no JSONB path needed.) Zero rows
returned (`consumed.length === 0`) is treated as "already consumed" →
writes `auth.mfa.challenge_failed` and throws `RuleError("Invalid code")`
(422), same as any other invalid-code path. Two concurrent requests with the
same code: only the first `UPDATE` matches a row; the second gets zero rows
back and fails.

## Fix 4 — audit before credential

`web/src/app/api/auth/mfa/challenge/route.ts:135-160`. Reordered so
`writeAudit({..., action: "auth.mfa.challenge_passed"})` runs, and only
after it resolves does `store.set(MFA_COOKIE_NAME, ...)` run. If `writeAudit`
throws, the function throws before `store.set` is ever reached, so no
`Set-Cookie` header is staged. The failed path was already audit-then-throw
(confirmed safe by the verifier) and is unchanged; the new backup-code
double-spend rejection (Fix 3) follows the same audit-then-throw discipline.

## Fix 5 — tests

- **`web/src/lib/auth/mfa.test.ts`**: 19 → **24 tests**. Every
  `issueMfaCookie`/`verifyMfaCookie` call updated for the 3-arg signature.
  New `describe("verifyMfaCookie — enrollment binding (R-91 fix)")`:
  `computeEnrollmentBinding` determinism, distinctness for different
  `enrolled_at` values, a cookie failing against a different `enr` (the
  disable+re-enroll scenario), and still passing for the same `uid`+`enr`.
  Extended the "missing fields" garbage-input case with an `enr`-missing
  variant.
- **`web/src/lib/auth/guard.test.ts`**: 23 → **35 tests**. Added
  `@/lib/auth/mfa`, `next/headers`, `@/lib/supabase/server`,
  `@/lib/supabase/admin` mocks (existing pure `requireScope`/self-approval
  tests are unaffected — they never touch these). New suites, all against
  the real `requireAuth`:
  - *MFA gate, session actors*: enrolled+valid cookie → passes and calls
    `verifyMfaCookie` with the current `enr`; enrolled+no cookie → rejects
    `{status: 401, code: "mfa_required"}`; enrolled+cookie for a different
    enrollment (mocked `verifyMfaCookie` → false) → same 401; not enrolled →
    passes without ever calling `verifyMfaCookie` or reading the cookie;
    `user_mfa` lookup error → **rejects** (fails closed) rather than
    resolving an actor.
  - *Token actors*: a valid Bearer PAT resolves without `getMfaEnrollmentStatus`
    or `verifyMfaCookie` ever being called.
  - *`MFA_CHALLENGE_EXEMPT_PATHS` exact-match*: `/api/auth/mfa` and
    `/api/auth/mfa/challenge` exempt even enrolled+unchallenged; a trailing
    slash and a different case are **not** exempt (gate still enforced); a
    query string does **not** break the exemption (`URL.pathname` excludes
    it); an unrelated path is not exempt.

**One deliberate wording deviation from your spec**: you listed "lookup
error → 401" as an expected guard-level test outcome. The actual (and, per
the verifier's item 3, already-confirmed-correct) behavior is that
`assertMfaSatisfied` does **not** catch the `getMfaEnrollmentStatus` error —
it propagates uncaught out of `requireAuth` itself, so at the `guard.ts`
level this is a **rejection**, not a 401. It only becomes an HTTP 401 vs. 500
one layer up, in `route()`'s catch (`toErrorResponse`'s generic-error branch
returns 500, not 401, per the verifier's confirmed finding). I wrote the test
to assert the true behavior (fails closed by rejecting) rather than assert a
literal 401 that guard.ts doesn't produce, and left a comment explaining the
distinction. Flagging in case you want `assertMfaSatisfied` changed to catch
and rethrow as an explicit `AuthError` — that would be a small additional
behavior change beyond the 5 listed fixes, so I didn't make it unprompted.

## Could not verify live

Same as the original report — no live Supabase/Vercel environment was
touched. `enrolled_at`'s exact Postgres timestamp string format (and thus
whether `computeEnrollmentBinding` receives a stable string across
reads) was verified by reading the migration and the `enroll`/`challenge`
route code paths, not by an actual round trip against Postgres.

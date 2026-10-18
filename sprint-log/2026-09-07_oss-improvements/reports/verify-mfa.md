# R-91 MFA login challenge — adversarial verification

Verified against actual code, not the worker's report. Test baseline: `npx tsc --noEmit`
clean; `npx vitest run` → **1976/1976 passing** (including `openapi-coverage.test.ts`,
which now passes — see note under item 6 header "stale claim").

## 1. Cookie forgery — CONFIRMED safe

- Signing key: `deriveSigningKey()` = `HMAC-SHA256(NOPM_ENCRYPTION_KEY, "nopm.mfa.cookie.v1")`
  (`web/src/lib/auth/mfa.ts:59-61`) — HKDF-Extract-shaped, raw AES key never reused
  directly as an HMAC key. Matches the report.
- base64url handled with try/catch around all `Buffer.from(...)` decodes
  (`mfa.ts:106-113`); malformed input never throws out of `verifyMfaCookie`.
- Constant-time compare: length check (`mfa.ts:114`) then `timingSafeEqual`
  (`mfa.ts:115`) — correct order (never call `timingSafeEqual` on mismatched
  lengths).
- Signature computed over the exact `payloadB64` string, not a derived/re-serialized
  form (`sign(payloadB64)`, `mfa.ts:63-65`) — no scope for payload/signature desync.
- `exp` enforced strictly: `payload.exp <= Math.floor(Date.now()/1000)` → false
  (`mfa.ts:125`).
- uid binding: `payload.uid !== uid` → false (`mfa.ts:124`) — a cookie issued for
  user A cannot satisfy user B; confirmed by `mfa.test.ts`'s "wrong uid" suite.
- `NOPM_ENCRYPTION_KEY` unset or wrong length: `loadEncryptionKey()` throws
  (`mfa.ts:41-55`). In `verifyMfaCookie`, that throw happens inside the `sign()`
  call at `mfa.ts:109`, which is wrapped in a `try { … } catch { return false; }`
  (`mfa.ts:108-113`) — fails closed, never signs with an empty/absent key. In
  `issueMfaCookie` (used only by `challenge/route.ts`), the same throw is
  **not** caught locally — it propagates out of the route handler and is turned
  into a sanitized 500 by `route()`'s catch (`handler.ts`), i.e. challenges
  hard-fail rather than silently succeeding. Both directions are fail-closed.

## 2. Gate bypass — REFUTED (significant)

`MFA_CHALLENGE_EXEMPT_PATHS` matching itself is fine: `new URL(request.url).pathname`
normalizes dot-segments per the WHATWG URL spec, so `/api/auth/mfa/challenge/../x`
resolves to `/api/auth/mfa/x`, not to the exempt path — no traversal bypass. Query
strings don't affect `pathname`. The exempt check is by pathname only, not method,
but the only route at `/api/auth/mfa` is `GET` (`web/src/app/api/auth/mfa/route.ts`
exports only `GET`) so this doesn't inadvertently exempt a mutating method there.
`/api/mcp/route.ts` is Bearer-PAT-only and never reaches the session/MFA branch of
`requireAuth` by construction (token actors return at `guard.ts:51-54`, before
`assertMfaSatisfied` is ever called) — not a bypass, that's the documented,
intentional split between PAT governance and session MFA. `demo-login/route.ts`
never calls `requireAuth` and never touches the `nopm_mfa` cookie — it only
establishes a Supabase session; subsequent calls are gated normally.

**The real gap**: `assertMfaSatisfied` only runs inside `requireAuth`, which is only
invoked by `route()` (`web/src/lib/api/handler.ts`) — i.e. only for API routes. Every
one of the 23 Server Components under `(console)/**/page.tsx` (dashboard, projects,
risks, budget, clashes, resources, portfolio, trust, etc. — confirmed by grep) reads
its data by calling `createClient()` from `@/lib/supabase/server` **directly**,
querying Postgres with the signed-in session's own RLS policies, entirely outside
`route()`/`requireAuth`. Example: `web/src/app/(console)/dashboard/page.tsx:52-56`
calls `db.auth.getUser()` then queries `projects` straight from the page component.

The *only* thing standing between an MFA-enrolled-but-unchallenged session and a
fully rendered dashboard/projects/risk-register/budget page is the layout-level
`requiresMfaChallenge()` redirect in `web/src/app/(console)/layout.tsx:16-18` — which
is explicitly fail-**open** by the worker's own design (`mfa.ts:160-184`, wrapped in
try/catch, returns `false` on any error).

The worker's report states: *"if this helper fails to redirect, the page renders,
but is non-functional until the challenge is passed anyway, because layer 1 still
gates every API call it makes... never worse than what layer 1 already allows."*
That's **false** for these pages: their data reads are not API calls, they're direct
SSR Postgres queries. If `requiresMfaChallenge()`'s single `user_mfa` lookup errors
(a blip on that one table, an RLS/policy hiccup, a timeout — independent of whether
the rest of the DB is healthy), the try/catch swallows it, the console renders, and
the page's own queries against `projects`/`risks`/`budget_lines`/etc. succeed
normally against real workspace data — no 401, no degraded page, a fully working
dashboard for a session that has explicitly not completed its second factor. This
directly contradicts "never worse than what layer 1 already allows": layer 1 (the
API gate) doesn't cover this surface at all.

On the non-error happy path this is fine — `redirect()` aborts the React tree before
the page component runs, so an enrolled-and-unchallenged user normally never sees
the console. But the severity claim in the report ("this is the real security
boundary... a miss here never opens a security hole") is not supported by the code.

## 3. Fail-closed vs fail-open

- **DB down at the API layer**: CONFIRMED deny. `isMfaEnabledForUser` throws on
  `error` (`mfa.ts:144`), uncaught in `assertMfaSatisfied` (`guard.ts:73-75`),
  propagates through `requireAuth`, caught by `route()`'s `catch` → sanitized 500
  (`errors.ts` `toErrorResponse`'s fallback branch). Correct fail-closed for every
  API-layer call. (The layout-level fail-open path is covered under item 2 above —
  same underlying `isMfaEnabledForUser` call, different caller, opposite policy.)
- **Disable + re-enroll with an old cookie still outstanding**: REFUTED — the old
  cookie stays valid. `verifyMfaCookie` only checks `{uid, exp}`; it has no
  awareness of the account's current MFA generation. Neither
  `web/src/app/api/auth/mfa/disable/route.ts` nor
  `web/src/app/api/auth/mfa/verify/route.ts` clears or invalidates the `nopm_mfa`
  cookie (grep confirms neither file imports `cookies` from `next/headers` at all).
  So: enrolled user passes a challenge → gets a cookie valid up to 12h → disables
  MFA (e.g. suspects their device/secret is compromised) → re-enrolls with a brand
  new TOTP secret and fresh backup codes → the pre-disable cookie is still
  unexpired and still matches `{uid}` → `verifyMfaCookie` returns `true` →
  `assertMfaSatisfied` is satisfied against the *new* enrollment without ever
  challenging it. The self-service "rotate my MFA because something's wrong" flow
  does not revoke outstanding satisfaction cookies for that account, up to 12h
  after the fact.

## 4. Backup-code consumption — REFUTED (race, low severity)

Not atomic. `challenge/route.ts:65-69` reads `backup_codes` via plain `select`;
`:99-106` computes `remaining = backupCodes.filter(h => h !== codeHash)` in JS and
writes it back with an unconditional `.update(...).eq("user_id", actor.id)` — no
compare-and-swap, no check of affected rows, no `WHERE backup_codes @> …` guard.
Two concurrent requests carrying the same still-valid backup code both read the
pre-consumption array, both see the hash present, both pass verification (both hit
`writeAudit("auth.mfa.challenge_passed")` and both get a signed cookie), and the two
updates race with last-write-wins — the code does end up removed, but it
authenticates two concurrent challenges instead of one. Not exploitable without
already possessing a valid backup code, so low severity, but it breaks the
single-use guarantee the report claims ("consumes... so it can never be reused" —
true for the *third* use, not for a second concurrent one). `verify`/`disable`
still function correctly against the shorter array afterward — they overwrite/clear
the whole array rather than filtering it, so no interaction bug there.

## 5. Attempt cap via audit_log — CONFIRMED safe (with a perf note)

- Cross-user DoS/bypass: not possible. The count filters `actor_id = actor.id`
  (`challenge/route.ts:55`), and `actor.id` comes from the caller's own verified
  session (`verifySession()`, `guard.ts:114-135`) — an attacker cannot generate
  `auth.mfa.challenge_failed` rows under another user's `actor_id` without that
  user's session, so neither exhausting nor resetting someone else's cap is
  possible from outside.
- Action-string match: exact (`"auth.mfa.challenge_failed"` on both the write at
  `:87-96` and the count filter at `:56`).
- Count vs. verify ordering: CONFIRMED correct — the count/cap check
  (`:51-63`) runs **before** the TOTP/backup verification (`:65-97`), not after.
- Workspace filter making count 0: N/A — `actor_id` is a globally unique user id,
  no workspace scoping needed.
- Perf note (not a security issue): the count query has no matching index —
  `audit_log` only has `(workspace_id, created_at desc)` and
  `(target_type, target_id)` (`supabase/migrations/20260608000006_governance.sql:17-18`).
  Filtering by `actor_id` + `action` + `created_at` will do a progressively wider
  scan as `audit_log` grows. Low urgency since it only runs on actual challenge
  attempts (not every request, unlike `isMfaEnabledForUser`), but worth an index
  if this table gets large.

## 6. Audit fail-closed, one row per attempt — REFUTED (ordering)

Failure path is correct: `writeAudit(...)` then `throw new RuleError("Invalid code")`
(`challenge/route.ts:86-97`) — if `writeAudit` itself throws, the whole request
still 500s and no cookie is ever issued (cookie code is further down, unreached).

Success path is backwards: `store.set(MFA_COOKIE_NAME, ...)` at **line 124** runs
BEFORE `writeAudit({..., action: "auth.mfa.challenge_passed"})` at **line 132**.
This matches the codebase's existing convention for DB mutations (`verify/route.ts`
and `disable/route.ts` also write their state change before calling `writeAudit`),
but a cookie is not a DB row: Next.js Route Handlers stage `cookies().set()` calls
into a request-scoped mutable cookie store that gets merged onto whatever `Response`
is ultimately returned for that request — including an error response built by
`route()`'s `catch` block after a later throw in the same handler invocation. So if
`writeAudit` fails here (e.g. a transient `audit_log` insert error), the client sees
a 500 (apparent failure), but the already-staged `Set-Cookie: nopm_mfa=...` header
is very likely still delivered — silently handing out a working, signed
MFA-satisfied credential with zero corresponding audit row. That is exactly the
failure mode item 6 asked about. I could not force a live `audit_log` insert failure
in this environment to get a hard repro of the header actually reaching the
response, so treat the Next.js internals part as high-confidence-but-not-proven;
the ordering itself is unambiguous from the source and should be fixed regardless
of exactly how forgiving the runtime turns out to be.

**Stale claim in the report**: the "1 known failing test" (`openapi-coverage.test.ts`
missing `/auth/mfa/challenge`) is no longer true — I ran the full suite
(`npx vitest run`) and got **1976/1976 passing**, and confirmed
`web/src/app/api/openapi.json/route.ts:1485` now documents `"/auth/mfa/challenge"`.
Another worker (owns that file) already added it. Not a defect in this worker's own
code — flagging only so the lead doesn't chase it.

## 7. Session expiry binding — CONFIRMED safe

`sessionExp` in `challenge/route.ts:111-120` comes from a fresh server-side
`supabase.auth.getSession()` call — read from Supabase Auth's own session record via
the request's cookies, not from any client-supplied JSON field. A client cannot
inject an arbitrary `sessionExpiresAt`. `issueMfaCookie`'s formula
(`mfa.ts:80-89`): `exp = min(sessionExpiresAt, now+12h)` only when
`sessionExpiresAt > now`, else flat 12h ceiling — matches the doc comment exactly,
and the `getSession()` failure path falls back to the ceiling too
(`challenge/route.ts:112-120`, `catch { sessionExp = null; }`).

## 8. UX — login loop, signout, secure flag — CONFIRMED, no issues

`/login` lives outside the `(console)` route group (`web/src/app/login/page.tsx`),
so the layout's `requiresMfaChallenge()` redirect can never target a page that would
itself re-trigger it — no redirect loop. The `?step=mfa` deep-link handler
(`login/page.tsx:67-87`) correctly branches: needs challenge → show it; already
satisfied → `router.replace("/dashboard")`; no session → falls back to the
credentials form. `signout/route.ts` deletes the cookie with `path: "/"`
(`signout/route.ts:23`), matching the `Path=/` used at issuance (neither route sets
a custom `domain`, so no attribute mismatch). `secure: process.env.NODE_ENV ===
"production"` is applied consistently in both `challenge/route.ts:126` and
`signout/route.ts`'s Supabase cookie adapter, matching the rest of the codebase's
cookie-setting convention.

## 9. Performance claim — CONFIRMED

`user_id` is the declared `primary key` of `user_mfa`
(`supabase/migrations/20260608000002_identity.sql:7`), so
`isMfaEnabledForUser`'s `.eq("user_id", userId)` is a true O(1) PK lookup, matching
the report. Confirmed it does **not** run for token actors: `requireAuth`
(`guard.ts:49-63`) returns early for any `Authorization: Bearer` request
(`:51-54`), before `assertMfaSatisfied` is ever called — only the session branch
reaches it. (Separately, see item 5's perf note: the challenge route's own
rate-limit count query against `audit_log` has no matching index — a different,
lower-urgency query than the one this item is about.)

## Untested surface (beyond the 9 items)

`web/src/lib/auth/guard.ts`'s actual R-91 additions — `assertMfaSatisfied` and
`isMfaChallengeExempt` — have **zero** automated test coverage. `mfa.test.ts`'s 19
tests exercise only `issueMfaCookie`/`verifyMfaCookie` in isolation. `guard.test.ts`
(23 pre-existing tests, still green) has no MFA-related assertions at all (`grep -n
"mfa\|Mfa\|MFA" src/lib/auth/guard.test.ts` → zero matches). None of the exempt-path
matching, the 401-with-`mfa_required`-code contract, the fail-closed-on-DB-error
behavior, or the token-actor-bypass is verified by any test — all of it was verified
manually for this review by reading the source. The RSC-bypass finding in item 2 is
exactly the kind of gap an integration/E2E test against a real console page would
have caught; a unit test on `guard.ts` alone would not.

## Overall verdict

**Not safe to ship as-is.** The cookie cryptography (item 1) is solid and the
API-layer gate itself (items 3's DB-down case, 5, 7, 9) is correctly fail-closed.
But the feature as built does **not** deliver "before any authenticated API call
succeeds" the way the report claims, because most of the console's actual data
reads never go through that gate at all (item 2) — the fail-open layout check is
the only defense for that surface, and its failure mode is worse than described.
Two further confirmed gaps (items 3's re-enrollment case, and 6's audit/cookie
ordering) mean an MFA rotation doesn't revoke old access, and a rare audit-write
failure can hand out a working credential with no audit trail. Item 4's race is
real but minor.

## Fix list

1. **`web/src/app/api/auth/mfa/challenge/route.ts`** (lines 122-140) — reorder:
   call `writeAudit({..., action: "auth.mfa.challenge_passed"})` first, and only
   call `issueMfaCookie` / `store.set(MFA_COOKIE_NAME, ...)` after that write
   resolves. Grant the credential only after the governance record of granting it
   is durably committed.

2. **`web/src/app/api/auth/mfa/challenge/route.ts`** (lines 99-106) — make backup
   code consumption atomic: e.g. a conditional update that only succeeds if the
   hash is still present (`.contains`/`@>` filter in the `WHERE` clause, or an
   `array_remove`-in-SQL RPC), and treat "0 rows affected" as "already consumed" →
   fail the challenge instead of proceeding.

3. **`web/src/app/api/auth/mfa/disable/route.ts`** and
   **`web/src/app/api/auth/mfa/verify/route.ts`** — clear the `nopm_mfa` cookie
   (`(await cookies()).delete({name: MFA_COOKIE_NAME, path: "/"})`) whenever the
   account's MFA configuration changes (disable, or a fresh verify/re-enrollment),
   so a previously issued satisfaction cookie cannot outlive the factor it attested
   to. Longer-term: bind the cookie payload to a value that changes on rotation
   (e.g. `confirmed_at`) instead of just `{uid, exp}`.

4. **Architectural** — `web/src/app/(console)/layout.tsx` +
   `web/src/lib/auth/mfa.ts`'s `requiresMfaChallenge`: either (a) make this check
   fail **closed** (render a retry/error state instead of the console on any
   error), since its own stated justification for fail-open doesn't hold for the
   23 pages that read data directly from Supabase outside `requireAuth`; or (b) if
   fail-open is kept deliberately, update `docs/SECURITY.md`'s new bullet to state
   plainly that most console reads bypass the API-layer MFA gate and rely solely on
   this check, rather than describing it as "never worse than what layer 1 already
   allows."

5. **`web/src/lib/auth/guard.test.ts`** — add coverage for `assertMfaSatisfied`
   and `isMfaChallengeExempt`: 401 with `code: "mfa_required"` when enrolled and
   unchallenged, exempt-path passthrough for both listed paths, fail-closed 500 on
   a `user_mfa` lookup error, and confirmation that token/PAT actors never reach
   the check at all.

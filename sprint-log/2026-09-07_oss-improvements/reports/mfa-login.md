# R-91 — MFA challenge at login

**Status:** Shipped and verified (`tsc --noEmit`, `vitest run`, `eslint`, `next build`
all clean except one pre-flagged, out-of-scope test failure — see "Known
failing test" below). Not committed (per file-scope instructions — no git
commits).

## What changed

Before this wave: users could enroll TOTP + get backup codes in Settings,
but login never asked for the code — the cookie session alone was
sufficient forever. Now an MFA-enrolled user must pass a challenge once per
session (capped at 12h) before any authenticated API call succeeds.

- **`web/src/lib/auth/mfa.ts` (NEW)** — the whole R-91 surface lives here:
  - `issueMfaCookie(uid, sessionExpiresAt?)` / `verifyMfaCookie(value, uid)` —
    signed cookie helpers, format below.
  - `isMfaEnabledForUser(userId)` — one admin-client lookup on `user_mfa`
    (deny-all RLS, same access pattern `enroll`/`verify`/`disable` already
    use). Errors propagate (never silently treated as "not enrolled").
  - `requiresMfaChallenge()` — a `cache()`d Server-Component helper for the
    (console) layout redirect. Fails **open** (returns `false`) on any
    error — this is UX-only; see "Two enforcement layers" below.
- **`web/src/lib/auth/mfa.test.ts` (NEW)** — 19 tests: valid round-trip
  (incl. session-expiry capping vs. the 12h ceiling, and a past-expiry
  session falling back to the ceiling), wrong uid, expired (via
  `vi.useFakeTimers`, both "past expiry" and "exact boundary"), tampered
  (payload swap, single-char flips in both segments, wrong signing key),
  and garbage input (null/empty/no-dot/non-base64url/non-JSON/missing-fields).
- **`web/src/lib/auth/guard.ts`** — `requireAuth`'s session branch now calls
  a new `assertMfaSatisfied(uid)` after `verifySession()`: if
  `isMfaEnabledForUser` is true and the request has no valid `nopm_mfa`
  cookie for that uid, throws `AuthError("MFA required", "mfa_required")`
  (401, with `code: "mfa_required"` in the JSON body so callers can tell
  this apart from a plain unauthenticated 401). Token (Bearer PAT) actors
  never reach this branch at all. Two paths are exempted by exact pathname
  (`MFA_CHALLENGE_EXEMPT_PATHS`): `GET /api/auth/mfa` (status poll) and
  `POST /api/auth/mfa/challenge` (the challenge itself) — otherwise an
  enrolled-but-unchallenged user could never reach the one endpoint that
  lets them satisfy the gate.
- **`web/src/app/api/auth/mfa/challenge/route.ts` (NEW)** —
  `POST { code }`: tries TOTP first (`authenticator.verify` against the
  decrypted secret), then falls back to a backup-code hash match; on match
  it **consumes** the backup code (filters that one hash out of the array —
  there was no existing "consume one" precedent to model, since
  verify/disable only ever write or clear the whole array). Attempt cap: 5
  failures per 10 minutes per user, enforced by counting
  `audit_log` rows with `action = 'auth.mfa.challenge_failed'` for that
  actor in the trailing window (no new counter table — this endpoint is the
  only writer of that action, so the count query is cheap and needs no
  schema change, per the spec's own suggested fallback). Success writes
  `auth.mfa.challenge_passed` (with `after: {via: "totp"|"backup_code"}`)
  and sets the cookie; failure writes `auth.mfa.challenge_failed` and
  returns 422 `"Invalid code"`. Cookie expiry is capped at the live
  Supabase session's own `expires_at` (via a second `getSession()` call) as
  well as the flat 12h ceiling.
- **`web/src/app/api/auth/mfa/route.ts` (extended, not replaced)** — `GET`
  now also returns `enrolled` (alias of the existing `enabled`, kept for the
  Settings-page consumer) and `satisfied` (true when unenrolled, or when
  the caller's own `nopm_mfa` cookie verifies). I extended this route
  rather than adding a new `/status` endpoint specifically to avoid
  widening the OpenAPI-coverage gap — see "Requests for lead" below.
- **`web/src/app/api/auth/signout/route.ts`** — now also deletes the
  `nopm_mfa` cookie. It doesn't go through `route()`/`requireAuth` at all
  (unchanged), so it needed no gate exemption.
- **`web/src/app/(console)/layout.tsx`** — `if (await requiresMfaChallenge())
  redirect("/login?step=mfa")` before the existing nav-mode/preferences
  work. This duplicates a session lookup `readSignedInPreferences` already
  makes elsewhere in the same request — see "Requests for lead".
- **`web/src/app/login/page.tsx`** — added an `MfaChallengeForm` step:
  - After a successful `signInWithPassword`, calls `GET /api/auth/mfa`; if
    `enrolled && !satisfied`, shows the code step and pushes
    `/login?step=mfa` into the URL (no page reload — same client state).
  - `?step=mfa` deep link: on mount, if the query param is present, polls
    the same status endpoint. Handles three outcomes: needs a challenge
    (show it), already satisfied (redirect straight to `/dashboard` — e.g.
    a user re-opens an old `/login?step=mfa` tab after already challenging
    elsewhere), or no session at all (falls back to the credentials form —
    e.g. the session expired between the console redirect and the click).
  - The code input toggles between "6-digit TOTP" and "32-char backup code"
    modes (placeholder/maxLength/inputMode change; no separate schema field
    on the server — `challenge/route.ts` tries both regardless of which UI
    mode was showing).
  - Demo button copy per spec: label → `"Try the shared live demo →"`,
    plus a caption `"Shared account, reseeded regularly. Do not enter real
    data."` — the demo account is never MFA-enrolled, so nothing about the
    demo funnel itself changes.
- **`web/src/components/demo-login-button.tsx`** — the actual button
  component (there's no `components/auth/**` directory in this repo — I
  edited the real file). Added an optional `caption` prop, rendered under
  the button when passed; every other caller (`case-study/page.tsx`,
  `app/page.tsx`) passes no `caption` and is visually unaffected (verified
  by reading their call sites — they don't set it, so the new `<p>` never
  renders for them).
- **`web/src/app/(console)/settings/page.tsx`** — one added sentence in the
  "not yet enrolled" copy: *"Once enabled, signing in will ask for a code
  from your app (or a backup code) before letting you into the workspace."*
- **`docs/SECURITY.md`** — one new bullet under "Security model" describing
  the challenge, the cookie's exact shape/lifetime, and the attempt cap.

## Cookie format (exact)

```
nopm_mfa = <payload_b64url>.<signature_b64url>
payload  = base64url(JSON.stringify({ uid, exp }))   // exp = unix seconds
signature = base64url(HMAC-SHA256(payload_b64url, signingKey))
signingKey = HMAC-SHA256(NOPM_ENCRYPTION_KEY_bytes, "nopm.mfa.cookie.v1")
```

`exp = min(sessionExpiresAt ?? +∞, now + 12h)`. The signing key is derived
from the same 32-byte `NOPM_ENCRYPTION_KEY` `@/lib/crypto` uses for
AES-256-GCM at rest, via a fixed-label HMAC (HKDF-Extract-shaped — one fixed
"info" string, no separate expand step needed for a single 32-byte output)
so the raw AES key is never reused directly as an HMAC key. Verification is
constant-time (`node:crypto.timingSafeEqual`) and never throws — any
malformed/tampered/garbage value verifies `false`. Cookie flags: `HttpOnly`,
`Secure` in production, `SameSite=Lax`, `Path=/`.

## Two enforcement layers, deliberately asymmetric

1. **`guard.ts`'s `assertMfaSatisfied`** (API layer) — fail-**closed**. Every
   authenticated API call from an enrolled, unchallenged session gets a 401.
   This is the real security boundary.
2. **`requiresMfaChallenge()`** (console layout) — fail-**open**. Its only
   job is UX: bounce the browser to the code screen before the console
   shell even renders, so the user isn't staring at a page where every
   fetch silently 401s. If it fails (DB hiccup, etc.) the page still
   renders, but is non-functional until the challenge is passed anyway,
   because layer 1 still gates every API call it makes. I chose fail-open
   here specifically because a layout-level outage must never be able to
   lock enrolled users out of a screen that only *shows* a login prompt —
   worst case they get a confusing console page instead of a redirect,
   never worse than what layer 1 already allows.

## Performance note

`assertMfaSatisfied` runs on **every** session-authenticated API call now,
not just for enrolled users — `isMfaEnabledForUser` has to query
`user_mfa` first to find out. That's one extra indexed (`user_id` is the
table's primary key) point lookup per request for the entire user base,
including the common case (not enrolled). This is the literal design the
R-91 brief asked for ("one cheap query, or piggy-back on the existing
profile query if there is one") and I didn't have write access to the file
that would let me piggyback (see Requests-for-lead item 3 — same
constraint, same file). Flagging in case the lead wants to fold this into
`profiles`/`readSignedInPreferences` later so enrollment status rides along
with a query that already happens.

## Test counts

- `mfa.test.ts`: **19 new tests**, all passing.
- Full suite: **1966 passing / 1 known failure** (below), up from the
  pre-existing baseline plus my 19.
- `npx tsc --noEmit`: clean.
- `npx eslint` on every file I touched: **0 errors, 0 warnings**.
- `npm run build`: clean, all routes compile (`/api/auth/mfa/challenge`
  present in the route manifest).

## Known failing test — NOT fixed, by design (file-scope boundary)

`src/lib/api/openapi-coverage.test.ts` fails exactly one assertion:

```
spec documents POST /auth/mfa/challenge
  AssertionError: Path "/auth/mfa/challenge" is missing from the OpenAPI spec.
```

`src/app/api/openapi.json/route.ts` is owned by another worker this wave
and I was told not to edit it. This test has **no allowlist mechanism** (unlike
`audit-coverage.test.ts`, which does) — there is nothing else I could add
this exemption to from within my scope. Everything else — the audit-coverage
test, the workspace-isolation test, the llms.txt-coverage test — is
unaffected and green, because I deliberately extended the existing,
already-documented `GET /api/auth/mfa` route instead of adding a new
`/status` path, which avoided a second undocumented-path failure.

## Requests for lead

1. **Add to `src/app/api/openapi.json/route.ts`** (pattern lifted straight
   from the existing `/auth/mfa/*` entries at line ~1451):

   ```ts
   "/auth/mfa/challenge": {
     post: {
       tags: ["auth"],
       summary: "Verify a TOTP code or backup code after password sign-in (R-91)",
       description: "scope: user session only. Exempt from the MFA-challenge gate itself. Rate-limited: 5 failed attempts / 10 min / user.",
       operationId: "challengeMfa",
       requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string", description: "6-digit TOTP code, or a 32-char backup code" } } } } } },
       responses: {
         "200": { description: "Challenge passed; nopm_mfa cookie set", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
         "422": { description: "Invalid code, or MFA not enabled for this account", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
         "429": { description: "Too many attempts (5 / 10 min)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
       },
     },
   },
   ```

   Also worth updating the existing `"/auth/mfa"` GET entry's description to
   mention the now-returned `enrolled`/`satisfied` fields (additive, no
   schema break — I left the entry itself untouched since it's in the file
   I can't edit).

2. **R-91 RTM text** (for `requirements/REQUIREMENTS.md` /
   `requirements/TRACEABILITY.md`, which I was also told not to touch):
   suggested wording — *"R-91: An account with TOTP/backup-code MFA enabled
   must pass a challenge (POST /api/auth/mfa/challenge) once per session
   (capped at 12h, never outliving the underlying Supabase session) before
   any other authenticated API call succeeds; enforced fail-closed in
   requireAuth (web/src/lib/auth/guard.ts), with a login-page UI step and a
   fail-open console-layout redirect as the UX front-end for the same
   invariant."* Files to cite: `web/src/lib/auth/mfa.ts`,
   `web/src/lib/auth/guard.ts`,
   `web/src/app/api/auth/mfa/challenge/route.ts`.

3. **Optional follow-up, not blocking**: `requiresMfaChallenge()` in
   `mfa.ts` does its own `auth.getUser()` call rather than sharing the one
   `readSignedInPreferences` (`web/src/lib/theme/server-prefs.ts`) already
   makes in the same request, because that reader is owned by another task
   this wave and has no MFA field. Folding `enrolled`/`satisfied` into that
   shared `cache()`d reader would save one Supabase Auth round trip per
   console page load. Not urgent — the extra call is cheap and this is a
   UX-only path (see "Two enforcement layers" above), but flagging it since
   it's the one place I'd have piggybacked on an existing query if I'd had
   write access to that file.

## Could not verify live

No live Supabase/Vercel environment was exercised in this task (no `.env.local`
DB credentials touched, no deploy). Everything above is verified by
`tsc`/`vitest`/`eslint`/`next build` only. In particular, **not** verified
against a real TOTP app or a real login round trip:
- That `otplib`'s `authenticator.verify` behaves identically against a
  live-enrolled secret as it does in the existing `verify`/`disable` routes
  (I reused the exact same decrypt-then-verify code path, so this should be
  safe by construction, but it's untested end-to-end here).
- That Next 16's `cookies().set()` inside a Route Handler and
  `cookies().delete({name, path})` behave as documented in the actual
  deployed runtime (Vercel Node.js) rather than just the local build.
- The demo funnel end-to-end (demo login was not exercised live) — by
  construction the demo account is never `user_mfa.enabled`, so
  `isMfaEnabledForUser` short-circuits `false` for it and nothing in the
  gate should touch it, but this is inference from the code path, not an
  observed live click-through.

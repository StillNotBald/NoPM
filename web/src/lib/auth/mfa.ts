/**
 * R-91 — MFA challenge at login.
 *
 * Two responsibilities live here:
 *  1. The signed `nopm_mfa` HttpOnly cookie: proof that a session actor has
 *     passed their TOTP/backup-code challenge (issued by
 *     POST /api/auth/mfa/challenge, checked by every subsequent request in
 *     `requireAuth` — see @/lib/auth/guard).
 *  2. `getMfaEnrollmentStatus` / `requiresMfaChallenge*` — the read paths
 *     that decide whether the cookie is required at all, and what it must
 *     be bound to (API guard.ts, and the (console) layout's pre-render
 *     redirect).
 *
 * Cookie format: `<payload_b64url>.<signature_b64url>` where payload is
 * base64url(JSON {uid, exp, enr}) and signature is base64url(HMAC-SHA256(
 * payload, signingKey)). `exp` is a unix-seconds timestamp capped at MIN(the
 * underlying Supabase session's own expiry, now + 12h) — the cookie can
 * never outlive the session it rides on, and never lives longer than 12h
 * even for a longer-lived session. `enr` (see `computeEnrollmentBinding`)
 * binds the cookie to the specific enrollment it was issued against
 * (`user_mfa.enrolled_at`) — disabling or re-enrolling MFA changes `enr`,
 * so a cookie issued before that change can never satisfy the new
 * enrollment (verified-adversarial finding: a stale cookie previously
 * survived disable+re-enroll for up to 12h).
 *
 * Signing key: derived from NOPM_ENCRYPTION_KEY (the same 32-byte key
 * @/lib/crypto uses for AES-256-GCM at rest — see that file for the env var
 * name) via HMAC-SHA256 with a fixed label, so the raw AES key is never
 * reused directly as an HMAC key (HKDF-Extract-shaped derivation, single
 * fixed "info" — no separate expand step needed for one 32-byte output).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const MFA_COOKIE_NAME = "nopm_mfa";
/** Ceiling on how long a challenge stays valid, regardless of session length. */
export const MFA_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60; // 12h

const SIGNING_KEY_LABEL = "nopm.mfa.cookie.v1";

/** `iat` (issued-at, unix seconds) is optional: cookies issued before R-4 do not carry it. */
type MfaCookiePayload = { uid: string; exp: number; enr: string; iat?: number };

/**
 * How recent a passed challenge must be to count as step-up proof for turning
 * two-step off or re-enrolling it (R-4). Someone who just spent a backup code
 * at /mfa/challenge would otherwise be stuck: disabling needed ANOTHER code,
 * re-enrolling was refused while two-step was on, and only the operator could
 * help once the cookie expired.
 */
export const MFA_RECENT_CHALLENGE_SECONDS = 10 * 60;

/**
 * Derive the `enr` (enrollment) binding value from `user_mfa.enrolled_at`.
 * `enrolled_at` is set to `now()` on every `POST /api/auth/mfa/enroll` call
 * (including re-enrollment — see enroll/route.ts's upsert), and is the only
 * column in the `user_mfa` schema that reliably changes on every distinct
 * enrollment: `totp_secret` is written to an empty string on disable (see
 * disable/route.ts), which would make a ciphertext-hash binding collide
 * across different disabled accounts, and there is no dedicated enrollment
 * id or `updated_at` column on this table (checked against
 * `supabase/migrations/20260608000002_identity.sql`). First 16 hex chars of
 * SHA-256 is plenty of entropy for a same-account binding check (this is
 * not a secret — it's mixed into a value that is itself HMAC-signed).
 */
export function computeEnrollmentBinding(enrolledAt: string): string {
  return createHash("sha256").update(enrolledAt).digest("hex").slice(0, 16);
}

function loadEncryptionKey(): Buffer {
  const raw = process.env.NOPM_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "NOPM_ENCRYPTION_KEY is not set. Provide a base64-encoded 32-byte key.",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `NOPM_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}).`,
    );
  }
  return buf;
}

/** Sub-key for cookie signing, derived from the app's encryption key so the
 *  raw AES-256-GCM key is never reused directly as an HMAC key. */
function deriveSigningKey(): Buffer {
  return createHmac("sha256", loadEncryptionKey()).update(SIGNING_KEY_LABEL).digest();
}

function sign(payloadB64: string): string {
  return createHmac("sha256", deriveSigningKey()).update(payloadB64).digest("base64url");
}

/**
 * Build the signed `nopm_mfa` cookie value for a user who has just passed
 * an MFA challenge.
 *
 * @param uid the session user's id
 * @param enr the current enrollment binding (`computeEnrollmentBinding(user_mfa.enrolled_at)`)
 *   — the cookie only ever satisfies the enrollment it was issued against.
 * @param sessionExpiresAt the underlying Supabase session's `expires_at`
 *   (unix seconds), if known — the cookie's own expiry is capped at this
 *   value so it never outlives the session.
 */
export function issueMfaCookie(
  uid: string,
  enr: string,
  sessionExpiresAt?: number | null,
): { value: string; maxAgeSeconds: number } {
  const now = Math.floor(Date.now() / 1000);
  const ceiling = now + MFA_COOKIE_MAX_AGE_SECONDS;
  const exp =
    sessionExpiresAt && sessionExpiresAt > now ? Math.min(sessionExpiresAt, ceiling) : ceiling;

  const payload: MfaCookiePayload = { uid, exp, enr, iat: now };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const value = `${payloadB64}.${sign(payloadB64)}`;

  return { value, maxAgeSeconds: Math.max(exp - now, 0) };
}

/**
 * Verify a `nopm_mfa` cookie value belongs to `uid`, was issued against the
 * current enrollment (`enr`), is correctly signed, and has not expired.
 * Constant-time signature compare. Never throws — malformed, tampered, or
 * garbage input all verify false.
 */
export function verifyMfaCookie(value: string | undefined | null, uid: string, enr: string): boolean {
  return readMfaCookie(value, uid, enr) !== null;
}

/**
 * True when the cookie verifies (see verifyMfaCookie) AND records an issue time
 * within the last `windowSeconds`. A cookie without `iat` (issued before R-4)
 * is never "recent", so it can only be replaced by a fresh challenge.
 */
export function isRecentMfaChallenge(
  value: string | undefined | null,
  uid: string,
  enr: string,
  windowSeconds: number = MFA_RECENT_CHALLENGE_SECONDS,
): boolean {
  const payload = readMfaCookie(value, uid, enr);
  if (!payload || typeof payload.iat !== "number") return false;
  const now = Math.floor(Date.now() / 1000);
  return payload.iat <= now + 5 && now - payload.iat <= windowSeconds;
}

function readMfaCookie(value: string | undefined | null, uid: string, enr: string): MfaCookiePayload | null {
  if (!value) return null;

  const dot = value.indexOf(".");
  if (dot === -1) return null;
  const payloadB64 = value.slice(0, dot);
  const providedSigB64 = value.slice(dot + 1);
  if (!payloadB64 || !providedSigB64) return null;

  let expectedSig: Buffer;
  let providedSig: Buffer;
  try {
    expectedSig = Buffer.from(sign(payloadB64), "base64url");
    providedSig = Buffer.from(providedSigB64, "base64url");
  } catch {
    return null;
  }
  if (expectedSig.length === 0 || expectedSig.length !== providedSig.length) return null;
  if (!timingSafeEqual(expectedSig, providedSig)) return null;

  let payload: MfaCookiePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.uid !== "string" ||
    typeof payload.exp !== "number" ||
    typeof payload.enr !== "string"
  ) {
    return null;
  }
  if (payload.uid !== uid) return null;
  if (payload.enr !== enr) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

export type MfaEnrollmentStatus = { enabled: boolean; enr: string | null };

/**
 * MFA status for this user: whether it's enabled, and (when enrolled) the
 * `enr` binding value for the current enrollment — one admin-client lookup
 * on `user_mfa` (deny-all RLS — service role only, same access pattern as
 * enroll/verify/disable). Errors propagate (never silently treated as "not
 * enrolled") so an infra hiccup surfaces as a loud failure, not a quiet
 * bypass of an enrolled user's own MFA requirement. `enr` is `null` only
 * when there is no `user_mfa` row at all (never enrolled).
 */
export async function getMfaEnrollmentStatus(userId: string): Promise<MfaEnrollmentStatus> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("user_mfa")
    .select("enabled, enrolled_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { enabled: false, enr: null };
  return { enabled: data.enabled ?? false, enr: computeEnrollmentBinding(data.enrolled_at) };
}

/**
 * Shared (request-cached) evaluation of the console-layout MFA gate: is the
 * current session's own challenge satisfied? Not exported directly — see
 * `requiresMfaChallenge` (fail-open) and `requiresMfaChallengeFailClosed`
 * (fail-closed) below, which both read from this single cached lookup so a
 * request never pays for more than one DB round trip regardless of which
 * variant(s) get called.
 */
const evaluateMfaChallenge = cache(async (): Promise<"satisfied" | "required" | "error"> => {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return "satisfied"; // no session — the page's own auth guard handles that

    const { enabled, enr } = await getMfaEnrollmentStatus(user.id);
    if (!enabled || enr === null) return "satisfied";

    const store = await cookies();
    const cookieValue = store.get(MFA_COOKIE_NAME)?.value;
    return verifyMfaCookie(cookieValue, user.id, enr) ? "satisfied" : "required";
  } catch {
    return "error";
  }
});

/**
 * Fail-OPEN variant: true only when the challenge is definitively required
 * (never on lookup error). Kept for reference/parity with the fail-closed
 * variant below; the (console) layout uses `requiresMfaChallengeFailClosed`
 * instead — see that function's doc comment for why fail-open is not safe
 * for that call site.
 */
export async function requiresMfaChallenge(): Promise<boolean> {
  return (await evaluateMfaChallenge()) === "required";
}

/**
 * Server-Component helper for the (console) layout's pre-render redirect.
 * True (→ redirect to the challenge) both when the challenge is actually
 * required AND when the lookup itself fails for any reason.
 *
 * This MUST fail closed: most of the 23 Server Components under
 * `(console)/**\/page.tsx` read their data via direct SSR Postgres queries
 * (their own `createClient()` + RLS), entirely outside `requireAuth`
 * (guard.ts) — the API-layer gate does not cover that surface at all. A
 * transient `user_mfa` lookup error (a blip on that one table, a timeout)
 * must therefore block the console render, not silently allow it while the
 * page's own SSR queries succeed against real workspace data (verified-
 * adversarial finding: the old fail-open version had exactly this gap).
 *
 * This duplicates a session lookup the layout's own preferences read
 * already performs (readSignedInPreferences, @/lib/theme/server-prefs) —
 * that reader is owned by another task this wave and has no MFA field, so a
 * second `auth.getUser()` here is the only option in scope. Flagged for the
 * lead as a follow-up: fold `enrolled`/`satisfied` into that shared cached
 * reader so console pages need only one session lookup per request.
 */
export async function requiresMfaChallengeFailClosed(): Promise<boolean> {
  return (await evaluateMfaChallenge()) !== "satisfied";
}

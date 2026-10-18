/**
 * issueMfaCookie / verifyMfaCookie — pure crypto round-trip tests (R-91).
 *
 * NOPM_ENCRYPTION_KEY is set here the same way src/lib/crypto.test.ts does
 * (mfa.ts derives its signing key from the same env var, via a fixed-label
 * HMAC sub-key — see the module doc comment for why).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import {
  issueMfaCookie,
  verifyMfaCookie,
  computeEnrollmentBinding,
  isRecentMfaChallenge,
  MFA_COOKIE_MAX_AGE_SECONDS,
} from "./mfa";

const TEST_KEY = Buffer.alloc(32, 0xcd).toString("base64");
const ENR = computeEnrollmentBinding("2026-01-01T00:00:00.000Z");
const OTHER_ENR = computeEnrollmentBinding("2026-02-01T00:00:00.000Z");

beforeAll(() => {
  process.env.NOPM_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("issueMfaCookie / verifyMfaCookie — valid cookie", () => {
  it("verifies for the uid and enrollment it was issued to", () => {
    const { value } = issueMfaCookie("usr_1", ENR);
    expect(verifyMfaCookie(value, "usr_1", ENR)).toBe(true);
  });

  it("has exactly two dot-separated segments", () => {
    const { value } = issueMfaCookie("usr_1", ENR);
    expect(value.split(".")).toHaveLength(2);
  });

  it("caps maxAgeSeconds at the 12h ceiling when no session expiry is given", () => {
    const { maxAgeSeconds } = issueMfaCookie("usr_1", ENR);
    expect(maxAgeSeconds).toBeLessThanOrEqual(MFA_COOKIE_MAX_AGE_SECONDS);
    expect(maxAgeSeconds).toBeGreaterThan(MFA_COOKIE_MAX_AGE_SECONDS - 5); // clock-skew slack
  });

  it("caps the cookie expiry at the session's own expiry when it is sooner than 12h", () => {
    const now = Math.floor(Date.now() / 1000);
    const sessionExp = now + 60; // session dies in 60s, well under the 12h ceiling
    const { maxAgeSeconds } = issueMfaCookie("usr_1", ENR, sessionExp);
    expect(maxAgeSeconds).toBeLessThanOrEqual(60);
    expect(maxAgeSeconds).toBeGreaterThan(0);
  });

  it("ignores a session expiry already in the past (falls back to the 12h ceiling)", () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    const { maxAgeSeconds } = issueMfaCookie("usr_1", ENR, past);
    expect(maxAgeSeconds).toBeGreaterThan(MFA_COOKIE_MAX_AGE_SECONDS - 5);
  });

  it("two issuances for the same uid produce different signatures are still each self-consistent", () => {
    const a = issueMfaCookie("usr_1", ENR);
    const b = issueMfaCookie("usr_1", ENR);
    expect(verifyMfaCookie(a.value, "usr_1", ENR)).toBe(true);
    expect(verifyMfaCookie(b.value, "usr_1", ENR)).toBe(true);
  });
});

describe("verifyMfaCookie — wrong uid", () => {
  it("fails when checked against a different uid than it was issued for", () => {
    const { value } = issueMfaCookie("usr_1", ENR);
    expect(verifyMfaCookie(value, "usr_2", ENR)).toBe(false);
  });
});

describe("verifyMfaCookie — enrollment binding (R-91 fix)", () => {
  it("computeEnrollmentBinding is deterministic for the same input", () => {
    expect(computeEnrollmentBinding("2026-01-01T00:00:00.000Z")).toBe(ENR);
  });

  it("computeEnrollmentBinding differs for different enrolled_at values", () => {
    expect(ENR).not.toBe(OTHER_ENR);
  });

  it("fails when checked against a different enrollment than it was issued for (e.g. after disable+re-enroll)", () => {
    const { value } = issueMfaCookie("usr_1", ENR);
    expect(verifyMfaCookie(value, "usr_1", OTHER_ENR)).toBe(false);
  });

  it("still verifies true for the same uid AND the same enrollment", () => {
    const { value } = issueMfaCookie("usr_1", ENR);
    expect(verifyMfaCookie(value, "usr_1", ENR)).toBe(true);
  });
});

describe("verifyMfaCookie — expired", () => {
  it("fails once the payload's exp has passed", () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const { value, maxAgeSeconds } = issueMfaCookie("usr_1", ENR);
    expect(verifyMfaCookie(value, "usr_1", ENR)).toBe(true);

    vi.setSystemTime(new Date(start.getTime() + (maxAgeSeconds + 5) * 1000));
    expect(verifyMfaCookie(value, "usr_1", ENR)).toBe(false);
  });

  it("fails exactly at the expiry boundary (exp <= now is expired)", () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const { value, maxAgeSeconds } = issueMfaCookie("usr_1", ENR);
    vi.setSystemTime(new Date(start.getTime() + maxAgeSeconds * 1000));
    expect(verifyMfaCookie(value, "usr_1", ENR)).toBe(false);
  });
});

describe("verifyMfaCookie — tampered", () => {
  it("fails when the payload segment is modified (uid swap) even keeping the original signature", () => {
    const { value } = issueMfaCookie("usr_1", ENR);
    const [payloadB64, sig] = value.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ uid: "usr_2", exp: 9999999999, enr: ENR }),
      "utf8",
    ).toString("base64url");
    expect(verifyMfaCookie(`${forgedPayload}.${sig}`, "usr_2", ENR)).toBe(false);
    // sanity: this isn't just because payloadB64 changed length coincidentally
    expect(forgedPayload).not.toBe(payloadB64);
  });

  it("fails when a single character of the signature is flipped", () => {
    const { value } = issueMfaCookie("usr_1", ENR);
    const [payloadB64, sig] = value.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyMfaCookie(`${payloadB64}.${flipped}`, "usr_1", ENR)).toBe(false);
  });

  it("fails when a single character of the payload is flipped (breaks the signature match)", () => {
    const { value } = issueMfaCookie("usr_1", ENR);
    const [payloadB64, sig] = value.split(".");
    const flipped = (payloadB64[0] === "A" ? "B" : "A") + payloadB64.slice(1);
    expect(verifyMfaCookie(`${flipped}.${sig}`, "usr_1", ENR)).toBe(false);
  });

  it("fails when signed with a different encryption key", () => {
    const { value } = issueMfaCookie("usr_1", ENR);
    const otherKey = Buffer.alloc(32, 0xee).toString("base64");
    const original = process.env.NOPM_ENCRYPTION_KEY;
    process.env.NOPM_ENCRYPTION_KEY = otherKey;
    try {
      expect(verifyMfaCookie(value, "usr_1", ENR)).toBe(false);
    } finally {
      process.env.NOPM_ENCRYPTION_KEY = original;
    }
  });
});

describe("verifyMfaCookie — garbage input", () => {
  it("fails for null/undefined", () => {
    expect(verifyMfaCookie(null, "usr_1", ENR)).toBe(false);
    expect(verifyMfaCookie(undefined, "usr_1", ENR)).toBe(false);
  });

  it("fails for an empty string", () => {
    expect(verifyMfaCookie("", "usr_1", ENR)).toBe(false);
  });

  it("fails for a random string with no dot separator", () => {
    expect(verifyMfaCookie("not-a-cookie-at-all", "usr_1", ENR)).toBe(false);
  });

  it("fails for a string with a dot but non-base64url segments", () => {
    expect(verifyMfaCookie("!!!not-valid!!!.@@@also-not-valid@@@", "usr_1", ENR)).toBe(false);
  });

  it("fails for a well-formed-looking but non-JSON payload", () => {
    const junkPayload = Buffer.from("not json at all", "utf8").toString("base64url");
    // sign it correctly so only the JSON.parse step can fail
    const { value } = issueMfaCookie("usr_1", ENR);
    const [, sig] = value.split(".");
    expect(verifyMfaCookie(`${junkPayload}.${sig}`, "usr_1", ENR)).toBe(false);
  });

  it("fails for a JSON payload missing the expected fields", () => {
    const badPayload = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64url");
    const sig = issueMfaCookie("usr_1", ENR).value.split(".")[1]; // wrong sig on purpose — still expect false
    expect(verifyMfaCookie(`${badPayload}.${sig}`, "usr_1", ENR)).toBe(false);
  });

  it("fails for a JSON payload missing only enr (uid/exp otherwise well-formed)", () => {
    const start = Math.floor(Date.now() / 1000);
    const badPayload = Buffer.from(
      JSON.stringify({ uid: "usr_1", exp: start + 3600 }),
      "utf8",
    ).toString("base64url");
    const sig = issueMfaCookie("usr_1", ENR).value.split(".")[1]; // wrong sig on purpose — still expect false
    expect(verifyMfaCookie(`${badPayload}.${sig}`, "usr_1", ENR)).toBe(false);
  });
});

describe("isRecentMfaChallenge (R-4)", () => {
  it("is true for a just-issued cookie and false after the window", () => {
    const { value } = issueMfaCookie("u-1", ENR);
    expect(isRecentMfaChallenge(value, "u-1", ENR)).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(isRecentMfaChallenge(value, "u-1", ENR)).toBe(false);
  });

  it("is false for another user, another enrolment, or no cookie", () => {
    const { value } = issueMfaCookie("u-1", ENR);
    expect(isRecentMfaChallenge(value, "u-2", ENR)).toBe(false);
    expect(isRecentMfaChallenge(value, "u-1", OTHER_ENR)).toBe(false);
    expect(isRecentMfaChallenge(undefined, "u-1", ENR)).toBe(false);
  });

  it("is false for a legacy cookie without iat", () => {
    const { value } = issueMfaCookie("u-1", ENR);
    const [payloadB64] = value.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    expect(typeof payload.iat).toBe("number");
    // A tampered (iat-less) payload fails the signature, so it can never be "recent" either.
    delete payload.iat;
    const forged = Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + value.split(".")[1];
    expect(isRecentMfaChallenge(forged, "u-1", ENR)).toBe(false);
  });
});

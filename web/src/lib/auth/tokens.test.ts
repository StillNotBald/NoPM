import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hasScope, hashToken, generateToken } from "./tokens";
import { PRIVILEGED_SCOPES, SCOPES } from "./scopes";

// ---------------------------------------------------------------------------
// hashToken
// ---------------------------------------------------------------------------
describe("hashToken", () => {
  it("produces the expected SHA-256 hex digest", () => {
    const raw = "npm_test_known_value";
    const expected = createHash("sha256").update(raw).digest("hex");
    expect(hashToken(raw)).toBe(expected);
  });

  it("is deterministic: same input always yields same hash", () => {
    const raw = "npm_deterministic_check";
    expect(hashToken(raw)).toBe(hashToken(raw));
  });

  it("raw token never equals its own hash", () => {
    const raw = "npm_abc123";
    expect(hashToken(raw)).not.toBe(raw);
  });

  it("different inputs produce different hashes (no collision for distinct tokens)", () => {
    expect(hashToken("npm_aaa")).not.toBe(hashToken("npm_bbb"));
  });
});

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------
describe("generateToken", () => {
  it("raw token starts with the npm_ prefix", () => {
    const { raw, prefix } = generateToken();
    expect(raw.startsWith(prefix)).toBe(true);
    expect(prefix).toBe("npm_");
  });

  it("hash stored is the SHA-256 of the raw token", () => {
    const { raw, hash } = generateToken();
    expect(hash).toBe(hashToken(raw));
  });

  it("raw is never equal to the stored hash", () => {
    const { raw, hash } = generateToken();
    expect(raw).not.toBe(hash);
  });

  it("produces a unique token on each call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  // --- prefix override (D13, f2b-specs.md — invites reuse this helper with
  // a distinct 'npi_' family instead of forking the token generator).
  it("uses the given prefix override instead of TOKEN_PREFIX", () => {
    const { raw, prefix } = generateToken("npi_");
    expect(prefix).toBe("npi_");
    expect(raw.startsWith("npi_")).toBe(true);
    expect(raw.startsWith("npm_")).toBe(false);
  });

  it("hash for a prefix-overridden token is still the SHA-256 of its own raw value", () => {
    const { raw, hash } = generateToken("npi_");
    expect(hash).toBe(hashToken(raw));
  });

  it("defaults to TOKEN_PREFIX when no override is given", () => {
    const { prefix } = generateToken();
    expect(prefix).toBe("npm_");
  });
});

// ---------------------------------------------------------------------------
// hasScope
// ---------------------------------------------------------------------------
describe("hasScope", () => {
  // --- exact match
  it("allows an exact scope match", () => {
    expect(hasScope(["task:read", "project:write"], "task:read")).toBe(true);
  });

  it("denies when exact scope is absent", () => {
    expect(hasScope(["task:read"], "task:write")).toBe(false);
  });

  // --- resource wildcard: resource:*
  it("allows when the token holds resource:* for the requested resource", () => {
    expect(hasScope(["task:*"], "task:read")).toBe(true);
    expect(hasScope(["task:*"], "task:write")).toBe(true);
    expect(hasScope(["task:*"], "task:delete:request")).toBe(true);
  });

  it("denies resource:* for a DIFFERENT resource", () => {
    expect(hasScope(["project:*"], "task:read")).toBe(false);
  });

  // --- admin wildcard: *
  it("allows any NON-privileged scope when the token holds *", () => {
    expect(hasScope(["*"], "task:read")).toBe(true);
    expect(hasScope(["*"], "project:delete")).toBe(true);
    expect(hasScope(["*"], "deletion_request:approve")).toBe(true);
    expect(hasScope(["*"], "task:delete:request")).toBe(true);
  });

  // --- empty / missing scopes
  it("denies when the granted scopes array is empty", () => {
    expect(hasScope([], "task:read")).toBe(false);
  });

  it("denies when granted scopes do not include the required scope at all", () => {
    expect(hasScope(["project:read", "risk:read"], "task:write")).toBe(false);
  });

  // --- compound action scope (three-part, e.g. task:delete:request)
  it("denies a three-part scope unless matched exactly or (non-privileged only) by resource:* or *", () => {
    expect(hasScope(["task:delete:request"], "task:delete:approve")).toBe(false);
    expect(hasScope(["task:*"], "task:delete:request")).toBe(true);
    expect(hasScope(["task:delete:approve"], "task:delete:approve")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D2 (2026-10-16): wildcards never grant a privileged (approve/decide) scope
// ---------------------------------------------------------------------------
describe("hasScope — wildcards never grant privileged scopes (D2)", () => {
  it("PRIVILEGED_SCOPES is exactly the four checker verbs", () => {
    expect([...PRIVILEGED_SCOPES].sort()).toEqual(
      [
        "change:decide",
        "project:delete:approve",
        "rebaseline:approve",
        "task:delete:approve",
      ].sort(),
    );
  });

  it("every privileged scope is a registered scope (the list can't drift onto a typo)", () => {
    const registry = new Set<string>(SCOPES);
    for (const s of PRIVILEGED_SCOPES) expect(registry.has(s)).toBe(true);
  });

  for (const scope of PRIVILEGED_SCOPES) {
    const resource = scope.split(":")[0];

    it(`${scope}: the global * does not grant it`, () => {
      expect(hasScope(["*"], scope)).toBe(false);
    });

    it(`${scope}: ${resource}:* does not grant it`, () => {
      expect(hasScope([`${resource}:*`], scope)).toBe(false);
    });

    it(`${scope}: an exact grant still does`, () => {
      expect(hasScope([scope], scope)).toBe(true);
    });

    it(`${scope}: * plus ${resource}:* together still do not grant it`, () => {
      expect(hasScope(["*", `${resource}:*`], scope)).toBe(false);
    });
  }

  it("a wildcard still grants every non-privileged scope of the resource (no over-correction)", () => {
    const privileged = new Set<string>(PRIVILEGED_SCOPES);
    for (const scope of SCOPES) {
      if (privileged.has(scope)) continue;
      expect(hasScope(["*"], scope), `* should grant ${scope}`).toBe(true);
      expect(hasScope([`${scope.split(":")[0]}:*`], scope), `resource:* should grant ${scope}`).toBe(true);
    }
  });

  it("holding task:delete:approve does not leak project:delete:approve (per-type gate)", () => {
    expect(hasScope(["task:delete:approve"], "project:delete:approve")).toBe(false);
  });
});

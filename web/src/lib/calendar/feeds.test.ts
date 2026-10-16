import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { Actor } from "@/lib/auth/guard";
import {
  feedOwner,
  feedUrl,
  generateFeedToken,
  parseFeedSegment,
  publicBaseUrl,
} from "./feeds";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const VALID_BODY = "A".repeat(43);

function userActor(overrides: Partial<Actor> = {}): Actor {
  return { type: "user", id: "profile_1", label: "Member", workspaceId: "ws_1", role: "member", ...overrides };
}

function tokenActor(overrides: Partial<Actor> = {}): Actor {
  return { type: "token", id: "tok_1", label: "agent", workspaceId: "ws_1", scopes: ["milestone:write"], ...overrides };
}

describe("generateFeedToken", () => {
  it("mints an npc_ token of 32 random bytes in base64url", () => {
    const { raw } = generateFeedToken();
    expect(raw).toMatch(/^npc_[A-Za-z0-9_-]{43}$/);
  });

  it("stores only the SHA-256 of the raw token", () => {
    const { raw, hash } = generateFeedToken();
    expect(hash).toBe(sha256(raw));
    expect(hash).not.toContain(raw);
  });

  it("gives every mint a fresh secret", () => {
    expect(generateFeedToken().raw).not.toBe(generateFeedToken().raw);
  });
});

describe("parseFeedSegment", () => {
  it("accepts a bare token and a token with the .ics suffix", () => {
    expect(parseFeedSegment(`npc_${VALID_BODY}`)).toBe(`npc_${VALID_BODY}`);
    expect(parseFeedSegment(`npc_${VALID_BODY}.ics`)).toBe(`npc_${VALID_BODY}`);
  });

  it("refuses a doubled suffix", () => {
    expect(parseFeedSegment(`npc_${VALID_BODY}.ics.ics`)).toBeNull();
  });

  it("refuses another token family, even with the right length", () => {
    expect(parseFeedSegment(`npm_${VALID_BODY}`)).toBeNull();
    expect(parseFeedSegment(`npi_${VALID_BODY}`)).toBeNull();
  });

  it("refuses the wrong length or characters outside base64url", () => {
    expect(parseFeedSegment("npc_short")).toBeNull();
    expect(parseFeedSegment(`npc_${"A".repeat(44)}`)).toBeNull();
    expect(parseFeedSegment(`npc_${"A".repeat(42)}+`)).toBeNull();
    expect(parseFeedSegment(`npc_${"A".repeat(42)}/`)).toBeNull();
  });

  it("refuses an empty segment", () => {
    expect(parseFeedSegment("")).toBeNull();
    expect(parseFeedSegment(".ics")).toBeNull();
  });
});

describe("feedOwner", () => {
  it("is the session user's own id", () => {
    expect(feedOwner(userActor())).toBe("profile_1");
  });

  it("prefers the recorded principal when one is present", () => {
    expect(feedOwner(userActor({ principalId: "profile_9" }))).toBe("profile_9");
  });

  it("is the token's principal, the person who minted it", () => {
    expect(feedOwner(tokenActor({ principalId: "profile_2" }))).toBe("profile_2");
  });

  it("is null for a legacy token with no recorded creator (fail-closed)", () => {
    expect(feedOwner(tokenActor({ principalId: null }))).toBeNull();
    expect(feedOwner(tokenActor())).toBeNull();
  });
});

describe("publicBaseUrl and feedUrl", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the request origin when no public URL is configured", () => {
    const request = new Request("http://internal.local:3000/api/calendar-feeds");
    expect(publicBaseUrl(request)).toBe("http://internal.local:3000");
  });

  it("prefers NEXT_PUBLIC_APP_URL and strips trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com/");
    const request = new Request("http://internal.local:3000/api/calendar-feeds");
    expect(publicBaseUrl(request)).toBe("https://nopm.example.com");
  });

  it("builds the subscription URL under /api/calendar with the .ics suffix", () => {
    expect(feedUrl("https://nopm.example.com", `npc_${VALID_BODY}`)).toBe(
      `https://nopm.example.com/api/calendar/npc_${VALID_BODY}.ics`,
    );
  });
});

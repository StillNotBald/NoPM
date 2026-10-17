import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { Actor } from "@/lib/auth/guard";
import {
  FEED_PAST_DAYS,
  etagMatches,
  feedEtag,
  feedOwner,
  feedRateCheck,
  feedUrl,
  feedWindowStart,
  generateFeedToken,
  isFeedAdmin,
  parseEnvInt,
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

describe("feedWindowStart", () => {
  it("is the UTC date FEED_PAST_DAYS before now", () => {
    expect(FEED_PAST_DAYS).toBe(90);
    expect(feedWindowStart(new Date("2026-10-17T10:00:00.000Z"))).toBe("2026-07-19");
    expect(feedWindowStart(new Date("2026-10-17T23:59:59.999Z"))).toBe("2026-07-19");
    expect(feedWindowStart(new Date("2027-02-01T00:00:00.000Z"))).toBe("2026-11-03"); // across a year-end
  });

  it("keeps every request in a day on the same boundary so the body stays byte-identical", () => {
    expect(feedWindowStart(new Date("2026-10-17T00:00:00Z"))).toBe(feedWindowStart(new Date("2026-10-17T23:59:00Z")));
  });
});

describe("feedEtag and etagMatches", () => {
  it("is a quoted, stable 128-bit tag of the body", () => {
    const tag = feedEtag("BEGIN:VCALENDAR\r\n");
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(feedEtag("BEGIN:VCALENDAR\r\n")).toBe(tag);
    expect(feedEtag("BEGIN:VCALENDAR\r\n ")).not.toBe(tag);
  });

  it("matches an exact tag, a weak tag, a member of a list and the wildcard", () => {
    const tag = feedEtag("body");
    expect(etagMatches(tag, tag)).toBe(true);
    expect(etagMatches(`W/${tag}`, tag)).toBe(true);
    expect(etagMatches(`"other", ${tag} , "x"`, tag)).toBe(true);
    expect(etagMatches("*", tag)).toBe(true);
  });

  it("does not match a different tag, an empty header or none at all", () => {
    const tag = feedEtag("body");
    expect(etagMatches(feedEtag("other body"), tag)).toBe(false);
    expect(etagMatches("", tag)).toBe(false);
    expect(etagMatches(null, tag)).toBe(false);
  });
});

describe("feedRateCheck", () => {
  const db = (reply: { data: unknown; error: { message: string } | null }) => ({
    calls: [] as unknown[],
    rpc(fn: string, args: Record<string, unknown>) {
      this.calls.push({ fn, args });
      return Promise.resolve(reply);
    },
  });

  it("asks the shared fixed-window counter for a 60 second window", async () => {
    const d = db({ data: { allowed: true, remaining: 5, retry_after_seconds: 0 }, error: null });
    expect(await feedRateCheck(d, "cal:abc", 60)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(d.calls).toEqual([{ fn: "nopm_rate_check", args: { p_key: "cal:abc", p_max: 60, p_window_seconds: 60 } }]);
  });

  it("reports a refusal with how long to wait", async () => {
    const d = db({ data: { allowed: false, remaining: 0, retry_after_seconds: 17 }, error: null });
    expect(await feedRateCheck(d, "cal:abc", 60)).toEqual({ allowed: false, retryAfterSeconds: 17 });
  });

  it("fails open, loudly, when the counter errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = db({ data: null, error: { message: "rpc down" } });
    expect(await feedRateCheck(d, "cal-ip:203.0.113.7", 120)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("203.0.113.7"); // the address is not logged
    log.mockRestore();
  });
});

describe("parseEnvInt", () => {
  it("takes a positive integer, trimmed", () => {
    expect(parseEnvInt("30", 120)).toBe(30);
    expect(parseEnvInt(" 45 ", 120)).toBe(45);
  });

  it("falls back for unset, empty, blank, non-numeric, fractional, zero and negative values", () => {
    for (const bad of [undefined, "", "   ", "abc", "12abc", "1.5", "0", "-5", "1e3", "Infinity", "NaN"]) {
      expect(parseEnvInt(bad, 120)).toBe(120);
    }
  });
});

describe("feed rate settings read from the environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("an empty NOPM_RATE_CAL_* setting keeps the default instead of becoming a cap of 0", async () => {
    vi.stubEnv("NOPM_RATE_CAL_IP_PER_MIN", "");
    vi.stubEnv("NOPM_RATE_CAL_PER_MIN", "");
    vi.resetModules();
    const fresh = await import("./feeds");
    expect(fresh.FEED_RATE_PER_IP).toBe(120);
    expect(fresh.FEED_RATE_PER_FEED).toBe(60);
  });

  it("a valid setting is honoured, a non-numeric one falls back", async () => {
    vi.stubEnv("NOPM_RATE_CAL_IP_PER_MIN", "30");
    vi.stubEnv("NOPM_RATE_CAL_PER_MIN", "lots");
    vi.resetModules();
    const fresh = await import("./feeds");
    expect(fresh.FEED_RATE_PER_IP).toBe(30);
    expect(fresh.FEED_RATE_PER_FEED).toBe(60);
  });
});

describe("isFeedAdmin", () => {
  it("is true for a signed-in admin only", () => {
    expect(isFeedAdmin(userActor({ role: "admin" }))).toBe(true);
    expect(isFeedAdmin(userActor({ role: "member" }))).toBe(false);
    expect(isFeedAdmin(userActor({ role: "viewer" }))).toBe(false);
    expect(isFeedAdmin(tokenActor({ role: "admin" }))).toBe(false);
  });
});

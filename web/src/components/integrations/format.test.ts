import { describe, expect, it } from "vitest";
import {
  LINK_CODE_TTL_MS,
  absoluteUrl,
  formatCountdown,
  formatDate,
  formatRelativeTime,
  larkWebhookUrls,
  linkMessage,
  parseExpiry,
  pluralise,
  remainingMs,
  toWebcalUrl,
  validateChatId,
  weekdayLabel,
  appUrlFromCallbackUrls,
  resolveAppUrl,
  resolveWebhookUrls,
  workerEnvBlock,
  type CallbackUrls,
} from "./format";

describe("formatCountdown", () => {
  it("renders the full 10-minute window", () => {
    expect(formatCountdown(LINK_CODE_TTL_MS)).toBe("10:00");
  });

  it("pads seconds and splits minutes", () => {
    expect(formatCountdown(9 * 60_000 + 42_000)).toBe("9:42");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(59_000)).toBe("0:59");
  });

  it("rounds a partial second UP so the last second reads 0:01, not 0:00", () => {
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(599_100)).toBe("10:00");
  });

  it("clamps at 0:00 once expired", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });
});

describe("remainingMs / parseExpiry", () => {
  it("never returns a negative remainder", () => {
    expect(remainingMs(1_000, 5_000)).toBe(0);
    expect(remainingMs(9_000, 5_000)).toBe(4_000);
  });

  it("reads an ISO expiry", () => {
    expect(parseExpiry("2026-10-16T10:10:00.000Z", 0)).toBe(Date.parse("2026-10-16T10:10:00.000Z"));
  });

  it("falls back to now + 10 minutes for a missing or invalid expiry", () => {
    expect(parseExpiry(undefined, 1_000)).toBe(1_000 + LINK_CODE_TTL_MS);
    expect(parseExpiry("not a date", 1_000)).toBe(1_000 + LINK_CODE_TTL_MS);
    expect(parseExpiry(42, 1_000)).toBe(1_000 + LINK_CODE_TTL_MS);
  });
});

describe("linkMessage", () => {
  it("is the exact bot command", () => {
    expect(linkMessage("NPL-ABCD-2345")).toBe("link NPL-ABCD-2345");
  });

  it("trims stray whitespace from the code", () => {
    expect(linkMessage("  NPL-ABCD-2345\n")).toBe("link NPL-ABCD-2345");
  });
});

describe("larkWebhookUrls", () => {
  it("builds absolute events and card URLs for the connector", () => {
    expect(larkWebhookUrls("https://app.example.com", "c0ffee")).toEqual({
      events: "https://app.example.com/api/integrations/lark/c0ffee/events",
      card: "https://app.example.com/api/integrations/lark/c0ffee/card",
    });
  });

  it("tolerates a trailing slash on the origin and encodes the id", () => {
    const urls = larkWebhookUrls("http://127.0.0.1:3000/", "a/b");
    expect(urls.events).toBe("http://127.0.0.1:3000/api/integrations/lark/a%2Fb/events");
  });
});

describe("workerEnvBlock", () => {
  it("omits the relay secret line once the secret is no longer known", () => {
    const block = workerEnvBlock({ origin: "https://app.example.com/", connectorId: "c1" });
    expect(block).toBe("NOPM_APP_URL=https://app.example.com\nNOPM_LARK_CONNECTOR_ID=c1");
  });

  it("includes the relay secret while it is still in hand", () => {
    const block = workerEnvBlock({ origin: "https://app.example.com", connectorId: "c1", relaySecret: "s3cret" });
    expect(block.split("\n")).toEqual([
      "NOPM_APP_URL=https://app.example.com",
      "NOPM_LARK_CONNECTOR_ID=c1",
      "NOPM_LARK_RELAY_SECRET=s3cret",
    ]);
  });
});

describe("resolveWebhookUrls", () => {
  const server: CallbackUrls = {
    events: "https://app.example.com/api/integrations/lark/c1/events",
    card: "https://app.example.com/api/integrations/lark/c1/card",
    relay: "https://app.example.com/api/integrations/lark/c1/relay",
  };

  it("prefers the server-built URLs, even when the browser address is known", () => {
    const urls = resolveWebhookUrls({ serverUrls: server, origin: "https://app.example.com", connectorId: "c1" });
    expect(urls).toEqual({ events: server.events, card: server.card, source: "server", hint: null });
  });

  it("hints when the configured app URL and the current address name different hosts", () => {
    const urls = resolveWebhookUrls({ serverUrls: server, origin: "https://preview.example.dev", connectorId: "c1" });
    expect(urls?.source).toBe("server");
    expect(urls?.events).toBe(server.events);
    expect(urls?.hint).toContain("https://app.example.com");
    expect(urls?.hint).toContain("https://preview.example.dev");
    expect(urls?.hint).toMatch(/differs/);
  });

  it("does not hint when the browser address is unknown (server render) or unparseable URLs are returned", () => {
    expect(resolveWebhookUrls({ serverUrls: server, origin: "", connectorId: "c1" })?.hint).toBeNull();
    const odd: CallbackUrls = { events: "not a url", card: "also not", relay: null };
    expect(resolveWebhookUrls({ serverUrls: odd, origin: "https://x.example", connectorId: "c1" })?.hint).toBeNull();
  });

  it("falls back to the browser address only when the server gave none", () => {
    expect(resolveWebhookUrls({ serverUrls: null, origin: "https://app.example.com/", connectorId: "c1" })).toEqual({
      events: "https://app.example.com/api/integrations/lark/c1/events",
      card: "https://app.example.com/api/integrations/lark/c1/card",
      source: "browser",
      hint: null,
    });
    expect(resolveWebhookUrls({ serverUrls: null, origin: "", connectorId: "c1" })).toBeNull();
  });
});

describe("appUrlFromCallbackUrls / resolveAppUrl", () => {
  it("recovers the configured app URL, keeping any path prefix", () => {
    expect(
      appUrlFromCallbackUrls({
        events: "https://app.example.com/api/integrations/lark/c1/events",
        card: "https://app.example.com/api/integrations/lark/c1/card",
        relay: null,
      }),
    ).toBe("https://app.example.com");
    expect(
      appUrlFromCallbackUrls({
        events: "https://example.com/nopm/api/integrations/lark/c1/events",
        card: "https://example.com/nopm/api/integrations/lark/c1/card",
        relay: null,
      }),
    ).toBe("https://example.com/nopm");
  });

  it("falls back to the origin of an unfamiliar events URL, and to null for junk", () => {
    expect(appUrlFromCallbackUrls({ events: "https://h.example/other/path", card: "x", relay: null })).toBe(
      "https://h.example",
    );
    expect(appUrlFromCallbackUrls({ events: "nope", card: "x", relay: null })).toBeNull();
  });

  it("prefers the server's app URL for the self-host worker, else the browser's", () => {
    const server: CallbackUrls = {
      events: "https://app.example.com/api/integrations/lark/c1/events",
      card: "https://app.example.com/api/integrations/lark/c1/card",
      relay: null,
    };
    expect(resolveAppUrl({ serverUrls: server, origin: "https://preview.example.dev" })).toBe("https://app.example.com");
    expect(resolveAppUrl({ serverUrls: null, origin: "https://preview.example.dev/" })).toBe("https://preview.example.dev");
    expect(resolveAppUrl({ serverUrls: null, origin: "" })).toBe("");
  });
});

describe("absoluteUrl / toWebcalUrl", () => {
  it("leaves an absolute URL untouched", () => {
    expect(absoluteUrl("https://x.example/api/calendar/npc_1.ics", "https://app.example.com")).toBe(
      "https://x.example/api/calendar/npc_1.ics",
    );
  });

  it("prefixes a root-relative URL with the origin", () => {
    expect(absoluteUrl("/api/calendar/npc_1.ics", "https://app.example.com/")).toBe(
      "https://app.example.com/api/calendar/npc_1.ics",
    );
  });

  it("switches http(s) to the webcal scheme only", () => {
    expect(toWebcalUrl("https://app.example.com/api/calendar/npc_1.ics")).toBe(
      "webcal://app.example.com/api/calendar/npc_1.ics",
    );
    expect(toWebcalUrl("http://127.0.0.1:3000/x.ics")).toBe("webcal://127.0.0.1:3000/x.ics");
  });
});

describe("weekdayLabel / validateChatId", () => {
  it("maps 0-6 to Sunday-Saturday and rejects anything else", () => {
    expect(weekdayLabel(0)).toBe("Sunday");
    expect(weekdayLabel(1)).toBe("Monday");
    expect(weekdayLabel(6)).toBe("Saturday");
    expect(weekdayLabel(7)).toBe("—");
    expect(weekdayLabel(1.5)).toBe("—");
  });

  it("requires a chat id that starts with oc_", () => {
    expect(validateChatId("")).toMatch(/Enter the group chat ID/);
    expect(validateChatId("   ")).toMatch(/Enter the group chat ID/);
    expect(validateChatId("ou_1234567890")).toMatch(/start with oc_/);
    expect(validateChatId("oc_short")).toMatch(/start with oc_/);
    expect(validateChatId("oc_1a2b3c4d5e6f")).toBeNull();
    // the API only accepts letters and digits after the prefix
    expect(validateChatId("oc_1a2b_3c4d5e6f")).toMatch(/start with oc_/);
    expect(validateChatId("  oc_a0553eda9014c201  ")).toBeNull();
  });
});

describe("formatRelativeTime / formatDate / pluralise", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");

  it("reads like the token list: Never / Just now / m / h / d", () => {
    expect(formatRelativeTime(null, now)).toBe("Never");
    expect(formatRelativeTime("garbage", now)).toBe("Never");
    expect(formatRelativeTime("2026-10-16T11:59:40Z", now)).toBe("Just now");
    expect(formatRelativeTime("2026-10-16T11:55:00Z", now)).toBe("5m ago");
    expect(formatRelativeTime("2026-10-16T09:00:00Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-10-14T12:00:00Z", now)).toBe("2d ago");
  });

  it("formats dates en-GB and dashes a missing value", () => {
    expect(formatDate("2026-10-16T23:30:00Z", "UTC")).toBe("16 Oct 2026");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("nope")).toBe("—");
  });

  it("pluralises", () => {
    expect(pluralise(1, "member")).toBe("1 member");
    expect(pluralise(3, "member")).toBe("3 members");
    expect(pluralise(0, "linked Lark account")).toBe("0 linked Lark accounts");
  });
});

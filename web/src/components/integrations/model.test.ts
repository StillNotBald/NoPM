import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECT_VALUES,
  buildClearTenantPinBody,
  buildCreateConnectorBody,
  buildFeedBody,
  buildSettingsPatchBody,
  buildStatusPatchBody,
  classifyError,
  errorText,
  digestOutcome,
  featuresFromConnector,
  findMyIdentity,
  normalizeConnector,
  normalizeCreatedConnector,
  normalizeDigestStatus,
  normalizeFeedCreated,
  normalizeFeeds,
  normalizeIdentities,
  normalizeLinkCode,
  normalizeProjects,
  normalizeTestResult,
  pickConnector,
  readDeliveryHealth,
  readOnlySummary,
  summariseDeliveryHealth,
  validateConnectForm,
  validateFeatures,
  type ConnectFormValues,
} from "./model";

const NOW = Date.parse("2026-10-16T12:00:00Z");

describe("classifyError", () => {
  const withStatus = (status: number, message = "boom") => Object.assign(new Error(message), { status });

  it("treats 404 as not-deployed and 403 as not-allowed, never as an alarm", () => {
    expect(classifyError(withStatus(404)).kind).toBe("unavailable");
    expect(classifyError(withStatus(403)).kind).toBe("forbidden");
  });

  it("keeps everything else as an error with the server's message", () => {
    expect(classifyError(withStatus(500, "db down"))).toEqual({ kind: "error", message: "db down" });
    expect(classifyError("weird").message).toBe("Something went wrong.");
  });
});

describe("errorText", () => {
  it("appends field-level detail from a 422", () => {
    const err = Object.assign(new Error("Validation failed"), {
      fields: [
        { field: "config.appId", message: "Required" },
        { field: "name", message: "Too long" },
      ],
    });
    expect(errorText(err, "fallback")).toBe("Validation failed (config.appId: Required; name: Too long)");
  });

  it("falls back for non-errors", () => {
    expect(errorText(undefined, "Could not do it.")).toBe("Could not do it.");
  });
});

describe("normalizeConnector", () => {
  it("reads a nested-config row (the LarkConfig shape)", () => {
    const c = normalizeConnector({
      id: "c1",
      name: "Team Lark",
      status: "paused",
      created_at: "2026-10-16T01:00:00Z",
      has_encrypt_key: true,
      config: {
        region: "feishu",
        appId: "cli_abc",
        mode: "long_connection",
        approvals: { enabled: true },
        digest: { enabled: true, chatId: "oc_12345678", weekday: 5 },
      },
    });
    expect(c).toMatchObject({
      id: "c1",
      name: "Team Lark",
      status: "paused",
      region: "feishu",
      mode: "long_connection",
      appId: "cli_abc",
      hasEncryptKey: true,
      approvalsEnabled: true,
      digest: { enabled: true, chatId: "oc_12345678", weekday: 5 },
      health: null,
    });
  });

  it("reads the public connector the API returns (flat snake_case)", () => {
    const c = normalizeConnector({
      id: "c0",
      kind: "lark",
      name: "Team Lark",
      status: "active",
      region: "feishu",
      app_id: "cli_pub",
      mode: "webhook",
      approvals: { enabled: false },
      digest: { enabled: true, chat_id: "oc_abcdef123456", weekday: 5 },
      has_app_secret: true,
      has_verification_token: true,
      has_encrypt_key: true,
      secrets_readable: false,
      has_relay_secret: false,
      created_at: "2026-10-16T01:00:00Z",
    });
    expect(c).toMatchObject({
      name: "Team Lark",
      region: "feishu",
      appId: "cli_pub",
      approvalsEnabled: false,
      hasEncryptKey: true,
      secretsReadable: false,
      digest: { enabled: true, chatId: "oc_abcdef123456", weekday: 5 },
    });
  });

  it("also reads a flat snake_case row", () => {
    const c = normalizeConnector({
      id: "c2",
      region: "lark",
      mode: "webhook",
      app_id: "cli_flat",
      approvals_enabled: true,
      digest_enabled: false,
    });
    expect(c).toMatchObject({ appId: "cli_flat", approvalsEnabled: true, mode: "webhook", status: "active" });
    expect(c?.digest).toEqual({ enabled: false, chatId: null, weekday: 1 });
  });

  it("defaults safely and rejects rows with no id", () => {
    expect(normalizeConnector({ id: "c3" })).toMatchObject({
      name: "Lark",
      region: "lark",
      mode: "webhook",
      approvalsEnabled: false,
      hasEncryptKey: false,
      secretsReadable: true,
      appId: "",
    });
    expect(normalizeConnector({ name: "x" })).toBeNull();
    expect(normalizeConnector(null)).toBeNull();
    expect(normalizeConnector("c1")).toBeNull();
  });

  it("ignores a weekday outside 0-6", () => {
    const c = normalizeConnector({ id: "c4", config: { digest: { enabled: true, weekday: 9 } } });
    expect(c?.digest.weekday).toBe(1);
  });

  it("reads delivery health when the API returns it, under any of its names", () => {
    const c = normalizeConnector({
      id: "c5",
      delivery_health: { sent: 12, retry: 1, failed: 0, last_sent_at: "2026-10-16T09:00:00Z", last_error: "429" },
    });
    expect(c?.health).toEqual({
      sent: 12,
      pending: 0,
      retrying: 1,
      dead: 0,
      lastSentAt: "2026-10-16T09:00:00Z",
      lastError: "429",
    });
  });
});

describe("pickConnector", () => {
  it("returns the first live connector and ignores revoked history", () => {
    const picked = pickConnector([
      { id: "old", status: "revoked" },
      { id: "live", status: "active" },
    ]);
    expect(picked?.id).toBe("live");
  });

  it("returns null for an empty or non-array response", () => {
    expect(pickConnector([])).toBeNull();
    expect(pickConnector([{ id: "x", status: "revoked" }])).toBeNull();
    expect(pickConnector(undefined)).toBeNull();
  });
});

describe("callback URLs", () => {
  it("reads server-built callback_urls and requires both the event and card URL", () => {
    const urls = {
      events: "https://app.example.com/api/integrations/lark/c1/events",
      card: "https://app.example.com/api/integrations/lark/c1/card",
      relay: "https://app.example.com/api/integrations/lark/c1/relay",
    };
    expect(normalizeConnector({ id: "c1", callback_urls: urls })?.callbackUrls).toEqual(urls);
    expect(normalizeConnector({ id: "c1", callback_urls: { events: urls.events } })?.callbackUrls).toBeNull();
    expect(normalizeConnector({ id: "c1" })?.callbackUrls).toBeNull();
  });

  it("keeps callback_urls from the create response on the connector", () => {
    const r = normalizeCreatedConnector({
      id: "c1",
      relay_secret: "rs",
      callback_urls: { events: "https://a.example/e", card: "https://a.example/c", relay: "https://a.example/r" },
    });
    expect(r.connector?.callbackUrls).toEqual({
      events: "https://a.example/e",
      card: "https://a.example/c",
      relay: "https://a.example/r",
    });
  });
});

describe("tenant pin", () => {
  it("reads tenant_pinned from the admin view and defaults to not pinned", () => {
    expect(normalizeConnector({ id: "c1", tenant_pinned: true })?.tenantPinned).toBe(true);
    expect(normalizeConnector({ id: "c1", tenant_pinned: false })?.tenantPinned).toBe(false);
    expect(normalizeConnector({ id: "c1" })?.tenantPinned).toBe(false);
  });

  it("is absent from (so defaults off for) the redacted member view", () => {
    const redacted = normalizeConnector({
      id: "c1",
      name: "Team Lark",
      kind: "lark",
      status: "active",
      region: "lark",
      mode: "webhook",
      approvals: { enabled: true },
      digest: { enabled: false },
    });
    expect(redacted?.tenantPinned).toBe(false);
  });

  it("clears the lock with a body that touches nothing else", () => {
    expect(buildClearTenantPinBody()).toEqual({ clear_tenant_pin: true });
  });
});

describe("redacted member view", () => {
  // Exactly the fields a non-admin member is given: no app id, chat id, secrets or health.
  const redacted = {
    id: "c1",
    name: "Team Lark",
    kind: "lark",
    status: "active",
    region: "feishu",
    mode: "long_connection",
    approvals: { enabled: true },
    digest: { enabled: true },
  };

  it("normalises without the admin-only fields", () => {
    expect(normalizeConnector(redacted)).toMatchObject({
      id: "c1",
      status: "active",
      region: "feishu",
      mode: "long_connection",
      approvalsEnabled: true,
      appId: "",
      callbackUrls: null,
      health: null,
      digest: { enabled: true, chatId: null, weekday: 1 },
    });
  });

  it("renders the one-line read-only status", () => {
    expect(readOnlySummary(normalizeConnector(redacted)!)).toBe("Lark connected · approvals on · digest on");
    expect(
      readOnlySummary(
        normalizeConnector({ ...redacted, status: "paused", approvals: { enabled: false }, digest: { enabled: false } })!,
      ),
    ).toBe("Lark paused · approvals off · digest off");
  });

  it("is what pickConnector selects for a member, ignoring revoked history", () => {
    expect(pickConnector([{ ...redacted, id: "old", status: "revoked" }, redacted])?.id).toBe("c1");
    expect(pickConnector([])).toBeNull();
  });
});

describe("normalizeCreatedConnector", () => {
  it("handles { connector, relay_secret }", () => {
    const r = normalizeCreatedConnector({ connector: { id: "c1" }, relay_secret: "rs_1" });
    expect(r.connector?.id).toBe("c1");
    expect(r.relaySecret).toBe("rs_1");
  });

  it("handles a flat connector carrying relay_secret", () => {
    const r = normalizeCreatedConnector({ id: "c2", relay_secret: "rs_2" });
    expect(r.connector?.id).toBe("c2");
    expect(r.relaySecret).toBe("rs_2");
  });

  it("survives an unexpected shape without throwing", () => {
    expect(normalizeCreatedConnector(null)).toEqual({ connector: null, relaySecret: null });
    expect(normalizeCreatedConnector({})).toEqual({ connector: null, relaySecret: null });
  });
});

describe("summariseDeliveryHealth", () => {
  const base = { sent: 0, pending: 0, retrying: 0, dead: 0, lastSentAt: null, lastError: null };

  it("is idle with no traffic", () => {
    expect(summariseDeliveryHealth(base, NOW)).toEqual({ tone: "neutral", text: "No deliveries yet" });
  });

  it("is healthy when things were sent and nothing is stuck", () => {
    const s = summariseDeliveryHealth({ ...base, sent: 8, lastSentAt: "2026-10-16T09:00:00Z" }, NOW);
    expect(s).toEqual({ tone: "success", text: "8 sent · last sent 3h ago" });
  });

  it("reads the admin view's counts (pending / retry / dead / last send): a recent send with nothing stuck is healthy", () => {
    const h = readDeliveryHealth({ pending: 0, retry: 0, dead: 0, last_sent_at: "2026-10-16T09:00:00Z", last_error: null });
    expect(h).not.toBeNull();
    expect(summariseDeliveryHealth(h!, NOW)).toEqual({ tone: "success", text: "last sent 3h ago" });
    const stuck = readDeliveryHealth({ pending: 2, retry: 1, dead: 0, last_sent_at: null });
    expect(summariseDeliveryHealth(stuck!, NOW)).toEqual({ tone: "warning", text: "2 queued · 1 retrying" });
    const dead = readDeliveryHealth({ pending: 0, retry: 0, dead: 3, last_sent_at: "2026-10-16T09:00:00Z" });
    expect(summariseDeliveryHealth(dead!, NOW).tone).toBe("danger");
  });

  it("escalates retrying to warning and dead to danger", () => {
    expect(summariseDeliveryHealth({ ...base, sent: 3, retrying: 2 }, NOW).tone).toBe("warning");
    const failing = summariseDeliveryHealth({ ...base, sent: 3, retrying: 2, dead: 1 }, NOW);
    expect(failing.tone).toBe("danger");
    expect(failing.text).toBe("3 sent · 2 retrying · 1 failed");
  });
});

describe("connect form", () => {
  const valid: ConnectFormValues = {
    ...DEFAULT_CONNECT_VALUES,
    appId: " cli_abc ",
    appSecret: "secret",
    verificationToken: "token",
  };

  // A webhook connection (the default) also needs the Encrypt Key; a long connection does not.
  const validWebhook: ConnectFormValues = { ...valid, encryptKey: "encrypt-key" };
  const validLong: ConnectFormValues = { ...valid, mode: "long_connection" };

  it("needs the three credentials for a long connection", () => {
    expect(validateConnectForm(validLong)).toEqual({});
  });

  it("also needs the Encrypt Key for a webhook connection (the API refuses it otherwise)", () => {
    expect(validateConnectForm(valid).encryptKey).toMatch(/Encrypt Key/);
    expect(validateConnectForm({ ...valid, encryptKey: "   " }).encryptKey).toBeTruthy();
    expect(validateConnectForm(validWebhook)).toEqual({});
    expect(validateConnectForm(validLong).encryptKey).toBeUndefined();
  });

  it("rejects an App ID with characters the API would refuse", () => {
    expect(validateConnectForm({ ...validWebhook, appId: "cli abc" }).appId).toMatch(/letters, digits/);
    expect(validateConnectForm({ ...validWebhook, appId: "cli_abc-1" })).toEqual({});
  });

  it("flags each missing credential and an empty name", () => {
    const errors = validateConnectForm({ ...DEFAULT_CONNECT_VALUES, name: " " });
    expect(Object.keys(errors).sort()).toEqual(["appId", "appSecret", "encryptKey", "name", "verificationToken"]);
    const long = validateConnectForm({ ...DEFAULT_CONNECT_VALUES, mode: "long_connection", name: " " });
    expect(Object.keys(long).sort()).toEqual(["appId", "appSecret", "name", "verificationToken"]);
  });

  it("requires a valid chat id only when the digest is on", () => {
    expect(validateFeatures({ ...valid, digestEnabled: false, digestChatId: "" })).toEqual({});
    expect(validateFeatures({ ...valid, digestEnabled: true, digestChatId: "" }).digestChatId).toBeTruthy();
    expect(validateFeatures({ ...valid, digestEnabled: true, digestChatId: "oc_abcdef123456" })).toEqual({});
  });

  it("builds the create body: flat snake_case, trimmed, encrypt key only when given", () => {
    const body = buildCreateConnectorBody(valid);
    expect(body).toEqual({
      kind: "lark",
      name: "Lark",
      region: "lark",
      mode: "webhook",
      app_id: "cli_abc",
      approvals: { enabled: true },
      digest: { enabled: false, chat_id: null, weekday: 1 },
      app_secret: "secret",
      verification_token: "token",
    });
    expect(body).not.toHaveProperty("encrypt_key");

    const withKey = buildCreateConnectorBody({ ...valid, encryptKey: " k " });
    expect(withKey.encrypt_key).toBe("k");
  });

  it("keeps secret material out of the non-secret blocks", () => {
    const body = buildCreateConnectorBody({ ...valid, encryptKey: "k" });
    expect(JSON.stringify({ approvals: body.approvals, digest: body.digest })).not.toMatch(/secret|token|key/i);
  });

  it("sends the digest chat when the digest is enabled, and null when there is none", () => {
    const on = buildCreateConnectorBody({ ...valid, digestEnabled: true, digestChatId: " oc_abcdef123456 ", digestWeekday: 4 });
    expect(on.digest).toEqual({ enabled: true, chat_id: "oc_abcdef123456", weekday: 4 });
    const off = buildCreateConnectorBody({ ...valid, digestEnabled: false, digestChatId: "" });
    expect(off.digest).toEqual({ enabled: false, chat_id: null, weekday: 1 });
  });

  it("keeps a well-formed chat id while the digest is off, but drops a malformed one", () => {
    const keep = buildSettingsPatchBody({
      approvalsEnabled: true,
      digestEnabled: false,
      digestChatId: "oc_abcdef123456",
      digestWeekday: 1,
    });
    expect(keep.digest).toEqual({ enabled: false, chat_id: "oc_abcdef123456", weekday: 1 });
    const drop = buildSettingsPatchBody({
      approvalsEnabled: true,
      digestEnabled: false,
      digestChatId: "not a chat id",
      digestWeekday: 1,
    });
    expect(drop.digest).toEqual({ enabled: false, chat_id: null, weekday: 1 });
  });

  it("edit-settings and pause/resume bodies never carry secrets", () => {
    const settings = buildSettingsPatchBody({
      approvalsEnabled: false,
      digestEnabled: true,
      digestChatId: "oc_abcdef123456",
      digestWeekday: 2,
    });
    expect(Object.keys(settings).sort()).toEqual(["approvals", "digest"]);
    expect(JSON.stringify(settings)).not.toMatch(/secret|token|encrypt/i);
    expect(buildStatusPatchBody("paused")).toEqual({ status: "paused" });
    expect(buildStatusPatchBody("active")).toEqual({ status: "active" });
  });

  it("seeds the edit panel from the live connector", () => {
    const c = normalizeConnector({
      id: "c1",
      config: { approvals: { enabled: false }, digest: { enabled: true, chatId: "oc_abcdef123456", weekday: 3 } },
    });
    expect(featuresFromConnector(c!)).toEqual({
      approvalsEnabled: false,
      digestEnabled: true,
      digestChatId: "oc_abcdef123456",
      digestWeekday: 3,
    });
  });
});

describe("normalizeTestResult", () => {
  it("is ok unless the API says otherwise", () => {
    expect(normalizeTestResult({ ok: true, bot_name: "NoPM Bot" })).toEqual({ ok: true, botName: "NoPM Bot", error: null });
    expect(normalizeTestResult(null).ok).toBe(true);
  });

  it("surfaces a failure from either ok:false or an error string", () => {
    expect(normalizeTestResult({ ok: false, error: "invalid app secret" })).toEqual({
      ok: false,
      botName: null,
      error: "invalid app secret",
    });
    expect(normalizeTestResult({ error: "boom" }).ok).toBe(false);
  });
});

describe("digest outcome", () => {
  it("maps the API's delivery status, defaulting an unknown one to queued", () => {
    expect(normalizeDigestStatus({ delivery_id: "d1", status: "sent" })).toBe("sent");
    expect(normalizeDigestStatus({ status: "retry" })).toBe("retry");
    expect(normalizeDigestStatus({ status: "dead" })).toBe("dead");
    expect(normalizeDigestStatus({ status: "queued" })).toBe("queued");
    expect(normalizeDigestStatus({ status: "???" })).toBe("queued");
    expect(normalizeDigestStatus(null)).toBe("queued");
  });

  it("tells the admin what really happened", () => {
    expect(digestOutcome("sent")).toEqual({ tone: "success", message: "Digest sent to the group chat." });
    expect(digestOutcome("queued").tone).toBe("info");
    expect(digestOutcome("retry").message).toMatch(/retry automatically/);
    expect(digestOutcome("dead")).toMatchObject({ tone: "error" });
  });
});

describe("identities", () => {
  const list = normalizeIdentities([
    { id: "i1", profile_id: "me", display_name: "Member One", linked_at: "2026-10-10T00:00:00Z" },
    { id: "i2", profile_id: "other", display_name: "Member Two", linked_at: "2026-10-11T00:00:00Z" },
    { id: "i3", profile_id: "me", revoked_at: "2026-10-12T00:00:00Z" },
    { nope: true },
  ]);

  it("drops rows without an id and flags revoked ones", () => {
    expect(list.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
    expect(list[2].revoked).toBe(true);
  });

  it("finds MY active link even when an admin is shown everyone's", () => {
    expect(findMyIdentity(list, "me")?.id).toBe("i1");
    expect(findMyIdentity(list, "someone-new")).toBeNull();
  });

  it("does not count a revoked link as linked", () => {
    expect(findMyIdentity(list.filter((i) => i.id === "i3"), "me")).toBeNull();
  });
});

describe("normalizeLinkCode", () => {
  it("reads code + ISO expiry", () => {
    expect(normalizeLinkCode({ code: "NPL-AAAA-BBBB", expires_at: "2026-10-16T12:10:00Z" }, NOW)).toEqual({
      code: "NPL-AAAA-BBBB",
      expiresAt: Date.parse("2026-10-16T12:10:00Z"),
    });
  });

  it("reads a relative expires_in (seconds)", () => {
    expect(normalizeLinkCode({ code: "NPL-AAAA-BBBB", expires_in: 600 }, NOW)?.expiresAt).toBe(NOW + 600_000);
  });

  it("defaults to a 10-minute window and rejects a response with no code", () => {
    expect(normalizeLinkCode({ code: "NPL-AAAA-BBBB" }, NOW)?.expiresAt).toBe(NOW + 10 * 60_000);
    expect(normalizeLinkCode({}, NOW)).toBeNull();
    expect(normalizeLinkCode(null, NOW)).toBeNull();
  });
});

describe("calendar feeds", () => {
  it("lists only live feeds, tolerating snake_case", () => {
    const feeds = normalizeFeeds([
      { id: "f1", name: "All milestones", project_id: null, created_at: "2026-10-01T00:00:00Z", last_fetched_at: null },
      { id: "f2", name: "Old", revoked_at: "2026-10-02T00:00:00Z" },
      { id: "f3", name: "One project", project_id: "p1" },
    ]);
    expect(feeds.map((f) => f.id)).toEqual(["f1", "f3"]);
    expect(feeds[1].projectId).toBe("p1");
  });

  it("reads the one-time URL and rejects a response without it", () => {
    expect(normalizeFeedCreated({ url: "https://app.example.com/api/calendar/npc_1.ics" })).toEqual({
      url: "https://app.example.com/api/calendar/npc_1.ics",
    });
    expect(normalizeFeedCreated({})).toBeNull();
  });

  it("builds the create body: name trimmed, project_id only when scoped", () => {
    expect(buildFeedBody({ name: " Mine ", projectId: "" })).toEqual({ name: "Mine" });
    expect(buildFeedBody({ name: "Mine", projectId: "p1" })).toEqual({ name: "Mine", project_id: "p1" });
  });

  it("keeps only projects that have an id and a name", () => {
    expect(normalizeProjects([{ id: "p1", name: "Alpha" }, { id: "p2" }, null, { name: "x" }])).toEqual([
      { id: "p1", name: "Alpha" },
    ]);
  });
});

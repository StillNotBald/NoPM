/**
 * Request-contract guard: the bodies this console sends must satisfy the
 * zod schemas the API routes validate with. The schemas are imported from the
 * routes' own `_schema.ts` files (pure zod, no server imports), so if a route
 * contract moves this fails here, loudly, instead of as a 422 in a browser.
 */
import { describe, expect, it } from "vitest";
import { createCalendarFeedSchema } from "@/app/api/calendar-feeds/_schema";
import { createConnectorSchema, updateConnectorSchema } from "@/app/api/integrations/connectors/_schema";
import {
  DEFAULT_CONNECT_VALUES,
  buildCreateConnectorBody,
  buildFeedBody,
  buildSettingsPatchBody,
  buildClearTenantPinBody,
  buildStatusPatchBody,
  normalizeCreatedConnector,
  pickConnector,
  readOnlySummary,
  type ConnectFormValues,
} from "./model";

const valid: ConnectFormValues = {
  ...DEFAULT_CONNECT_VALUES,
  appId: "cli_a1b2c3",
  appSecret: "app-secret-value",
  verificationToken: "verification-token-value",
};

describe("POST /api/integrations/connectors body", () => {
  it("is accepted for a minimal first connection", () => {
    const parsed = createConnectorSchema.safeParse(buildCreateConnectorBody(valid));
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it("is accepted with every optional field filled in (feishu, long connection, encrypt key, digest)", () => {
    const parsed = createConnectorSchema.safeParse(
      buildCreateConnectorBody({
        ...valid,
        region: "feishu",
        mode: "long_connection",
        encryptKey: "encrypt-key-value",
        approvalsEnabled: false,
        digestEnabled: true,
        digestChatId: "oc_0123456789abcdef",
        digestWeekday: 5,
      }),
    );
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it("round-trips the values the admin typed", () => {
    const parsed = createConnectorSchema.parse(
      buildCreateConnectorBody({ ...valid, name: "  Team Lark ", encryptKey: "k" }),
    );
    expect(parsed).toMatchObject({
      kind: "lark",
      name: "Team Lark",
      region: "lark",
      mode: "webhook",
      app_id: "cli_a1b2c3",
      app_secret: "app-secret-value",
      verification_token: "verification-token-value",
      encrypt_key: "k",
      approvals: { enabled: true },
      digest: { enabled: false, chat_id: null, weekday: 1 },
    });
  });
});

describe("PATCH /api/integrations/connectors/[id] bodies", () => {
  it("accepts the edit-settings body, digest on and off", () => {
    const on = buildSettingsPatchBody({
      approvalsEnabled: true,
      digestEnabled: true,
      digestChatId: "oc_0123456789abcdef",
      digestWeekday: 3,
    });
    expect(updateConnectorSchema.safeParse(on).success).toBe(true);

    const off = buildSettingsPatchBody({
      approvalsEnabled: false,
      digestEnabled: false,
      digestChatId: "",
      digestWeekday: 1,
    });
    expect(updateConnectorSchema.safeParse(off).success).toBe(true);
  });

  it("accepts clear_tenant_pin and sends nothing but that flag", () => {
    const parsed = updateConnectorSchema.safeParse(buildClearTenantPinBody());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ clear_tenant_pin: true });
  });

  it("accepts pause and resume", () => {
    expect(updateConnectorSchema.safeParse(buildStatusPatchBody("paused")).success).toBe(true);
    expect(updateConnectorSchema.safeParse(buildStatusPatchBody("active")).success).toBe(true);
  });

  it("never sends credential fields from the edit-settings panel", () => {
    const parsed = updateConnectorSchema.parse(
      buildSettingsPatchBody({ approvalsEnabled: true, digestEnabled: false, digestChatId: "", digestWeekday: 1 }),
    );
    expect(parsed).not.toHaveProperty("app_secret");
    expect(parsed).not.toHaveProperty("verification_token");
    expect(parsed).not.toHaveProperty("encrypt_key");
  });
});

describe("connector response shapes", () => {
  it("reads the create response: connector fields, one-time relay secret, server-built callback_urls", () => {
    // Shape of POST /api/integrations/connectors (201): { ...public connector, relay_secret, callback_urls }.
    const created = normalizeCreatedConnector({
      id: "c1",
      kind: "lark",
      name: "Team Lark",
      status: "active",
      region: "lark",
      app_id: "cli_a1b2c3",
      mode: "long_connection",
      approvals: { enabled: true },
      digest: { enabled: false, chat_id: null, weekday: 1 },
      has_app_secret: true,
      has_verification_token: true,
      has_encrypt_key: false,
      secrets_readable: true,
      has_relay_secret: true,
      relay_secret: "relay-secret-once",
      callback_urls: {
        events: "https://configured.example.com/api/integrations/lark/c1/events",
        card: "https://configured.example.com/api/integrations/lark/c1/card",
        relay: "https://configured.example.com/api/integrations/lark/c1/relay",
      },
    });
    expect(created.relaySecret).toBe("relay-secret-once");
    expect(created.connector).toMatchObject({ id: "c1", mode: "long_connection", appId: "cli_a1b2c3" });
    expect(created.connector?.callbackUrls?.events).toBe("https://configured.example.com/api/integrations/lark/c1/events");
  });

  it("reads tenant_pinned from the admin list (a boolean; the key itself is never sent)", () => {
    const [pinned, open] = [true, false].map((tenant_pinned) =>
      pickConnector([
        {
          id: "c1",
          name: "Team Lark",
          kind: "lark",
          status: "active",
          region: "lark",
          app_id: "cli_a1b2c3",
          mode: "webhook",
          approvals: { enabled: true },
          digest: { enabled: false, chat_id: null, weekday: 1 },
          has_encrypt_key: false,
          tenant_pinned,
        },
      ]),
    );
    expect(pinned?.tenantPinned).toBe(true);
    expect(open?.tenantPinned).toBe(false);
  });

  it("reads the redacted member list (id, name, kind, status, region, mode, approvals.enabled, digest.enabled)", () => {
    const picked = pickConnector([
      {
        id: "c1",
        name: "Team Lark",
        kind: "lark",
        status: "active",
        region: "lark",
        mode: "webhook",
        approvals: { enabled: true },
        digest: { enabled: false },
      },
    ]);
    expect(picked).not.toBeNull();
    expect(readOnlySummary(picked!)).toBe("Lark connected · approvals on · digest off");
  });

  it("treats an empty list (no connector, or a member with nothing to see) as not connected", () => {
    expect(pickConnector([])).toBeNull();
  });
});

describe("POST /api/calendar-feeds body", () => {
  it("is accepted for the whole workspace and for one project", () => {
    expect(createCalendarFeedSchema.safeParse(buildFeedBody({ name: "My milestones", projectId: "" })).success).toBe(true);
    expect(
      createCalendarFeedSchema.safeParse(
        buildFeedBody({ name: "One project", projectId: "6f1c0a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b" }),
      ).success,
    ).toBe(true);
  });
});

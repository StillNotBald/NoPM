/**
 * Test fixtures for the Lark adapter: platform-shaped payloads plus the signing
 * and encryption a real Lark/Feishu delivery would apply.
 *
 * Deliberately a SEPARATE implementation of the documented scheme (AES-256-CBC,
 * key = SHA-256(encryptKey), IV prepended; signature = hex SHA-256 of
 * timestamp + nonce + encryptKey + rawBody) rather than a re-export of
 * verify.ts, so verification tests compare two independent implementations
 * instead of testing the code against itself. Import from tests only — nothing
 * in the app bundle references this file.
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { vi } from "vitest";
import type { ConnectorRow, LarkConfig, LarkSecrets, OutboundMessage } from "@/lib/integrations/types";
import type { LarkHandlerDeps } from "./handlers";

export const FIXTURE_APP_ID = "cli_fixture_app";
export const FIXTURE_VERIFICATION_TOKEN = "vt_fixture_verification_token";
export const FIXTURE_ENCRYPT_KEY = "ek_fixture_encrypt_key";
export const FIXTURE_CONNECTOR_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
export const FIXTURE_TENANT = "tenant_fixture_1";
export const FIXTURE_OPEN_ID = "ou_fixture_user_1";
export const FIXTURE_APP_URL = "https://nopm.example.test";

/** Encrypt an event the way the platform does: base64(iv || AES-256-CBC(plaintext)). */
export function encryptBody(plaintext: string, encryptKey: string, iv: Buffer = randomBytes(16)): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({ encrypt: Buffer.concat([iv, body]).toString("base64") });
}

/** The three signature headers for a raw body. */
export function signBody(input: {
  rawBody: string;
  encryptKey: string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? "nonce-fixture-1";
  const signature = createHash("sha256")
    .update(timestamp + nonce + input.encryptKey + input.rawBody, "utf8")
    .digest("hex");
  return {
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature,
  };
}

export function urlVerificationBody(token = FIXTURE_VERIFICATION_TOKEN, challenge = "challenge-fixture-abc") {
  return { challenge, token, type: "url_verification" };
}

export function messageEvent(overrides: {
  text?: string;
  eventId?: string;
  /** The message id (default om_fixture_msg_1); null leaves the message without one. */
  messageId?: string | null;
  openId?: string;
  chatType?: string;
  messageType?: string;
  senderType?: string;
  content?: string;
  token?: string;
  appId?: string;
} = {}) {
  const text = overrides.text ?? "help";
  return {
    schema: "2.0",
    header: {
      event_id: overrides.eventId ?? "evt_msg_fixture_1",
      event_type: "im.message.receive_v1",
      create_time: "1760000000000",
      token: overrides.token ?? FIXTURE_VERIFICATION_TOKEN,
      app_id: overrides.appId ?? FIXTURE_APP_ID,
      tenant_key: FIXTURE_TENANT,
    },
    event: {
      sender: {
        sender_id: { union_id: "on_fixture_union_1", user_id: "u_fixture_1", open_id: overrides.openId ?? FIXTURE_OPEN_ID },
        sender_type: overrides.senderType ?? "user",
        tenant_key: FIXTURE_TENANT,
      },
      message: {
        ...(overrides.messageId === null ? {} : { message_id: overrides.messageId ?? "om_fixture_msg_1" }),
        chat_id: "oc_fixture_dm_1",
        chat_type: overrides.chatType ?? "p2p",
        message_type: overrides.messageType ?? "text",
        content: overrides.content ?? JSON.stringify({ text }),
      },
    },
  };
}

export function cardActionEvent(overrides: {
  eventId?: string;
  token?: string;
  appId?: string;
  openId?: string | null;
  tenantKey?: string | null;
  value?: unknown;
  formValue?: Record<string, unknown>;
  tag?: string;
} = {}) {
  const operator: Record<string, unknown> = {
    union_id: "on_fixture_union_1",
    user_id: "u_fixture_1",
  };
  if (overrides.openId !== null) operator.open_id = overrides.openId ?? FIXTURE_OPEN_ID;
  if (overrides.tenantKey !== null) operator.tenant_key = overrides.tenantKey ?? FIXTURE_TENANT;
  return {
    schema: "2.0",
    header: {
      event_id: overrides.eventId ?? "evt_card_fixture_1",
      event_type: "card.action.trigger",
      create_time: "1760000000000000",
      token: overrides.token ?? FIXTURE_VERIFICATION_TOKEN,
      app_id: overrides.appId ?? FIXTURE_APP_ID,
      tenant_key: FIXTURE_TENANT,
    },
    event: {
      operator,
      token: "c-callback-token-fixture",
      action: {
        value: overrides.value === undefined ? { t: "raw-action-token-1", a: "approve" } : overrides.value,
        tag: overrides.tag ?? "button",
        timezone: "Asia/Kuala_Lumpur",
        ...(overrides.formValue ? { form_value: overrides.formValue } : {}),
      },
      host: "im_message",
      context: { open_message_id: "om_fixture_card_1", open_chat_id: "oc_fixture_dm_1" },
    },
  };
}

export function fixtureConfig(overrides: Partial<LarkConfig> = {}): LarkConfig {
  return {
    region: "lark",
    appId: FIXTURE_APP_ID,
    mode: "webhook",
    approvals: { enabled: true },
    digest: { enabled: true, chatId: "oc_fixture_group_1", weekday: 1 },
    ...overrides,
  };
}

export function fixtureConnector(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: FIXTURE_CONNECTOR_ID,
    workspace_id: FIXTURE_WORKSPACE_ID,
    kind: "lark",
    name: "Fixture Lark",
    status: "active",
    config: fixtureConfig(),
    secret_enc: "enc:unused-in-tests",
    relay_secret_hash: null,
    created_by: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

export function fixtureSecrets(overrides: Partial<LarkSecrets> = {}): LarkSecrets {
  return {
    appSecret: "app-secret-fixture-NEVER-LOG",
    verificationToken: FIXTURE_VERIFICATION_TOKEN,
    encryptKey: null,
    ...overrides,
  };
}

/**
 * Hub-core doubles with sensible happy-path defaults. `sent` collects every
 * message the handlers send, `deps.log` / the `vi.fn`s expose call history.
 */
export function fakeHandlerDeps(over: Partial<LarkHandlerDeps> = {}) {
  const sent: OutboundMessage[] = [];
  const deps: LarkHandlerDeps = {
    handleApprovalAction: vi.fn(async () => ({
      status: "decided" as const,
      action: "approve" as const,
      ref: { kind: "task_deletion" as const, id: "33333333-3333-4333-8333-333333333333" },
      title: "Delete task Alpha",
      newStatus: "committed",
    })),
    consumeLinkCode: vi.fn(async () => ({ status: "linked" as const, profileLabel: "Sam Approver", alreadyLinked: false })),
    countPending: vi.fn(async () => ({ status: "ok" as const, deletions: 2, changeRequests: 1 })),
    claimEvent: vi.fn(async () => true),
    send: vi.fn(async (_connector: ConnectorRow, _secrets: LarkSecrets, msg: OutboundMessage) => {
      sent.push(msg);
      return { ok: true as const, externalMessageId: "om_reply_1" };
    }),
    now: () => new Date("2026-10-16T09:30:00.000Z"),
    log: vi.fn(),
    ...over,
  };
  return { deps, sent };
}

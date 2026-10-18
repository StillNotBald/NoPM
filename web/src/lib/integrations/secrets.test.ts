import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  decryptSecrets,
  deriveActionToken,
  encryptSecrets,
  generateRelaySecret,
  hashRelaySecret,
  relayHmacKey,
  safeEqual,
  sanitizeError,
  secretsView,
} from "./secrets";
import { generateToken } from "@/lib/auth/tokens";
import { generateFeedToken } from "@/lib/calendar/feeds";
import { generateLinkCode } from "./identity";
import { normalizeConfig, toPublicConnector, assertIntegrationAdmin, appBaseUrl } from "./store";
import { APP_SECRET, TEST_ENCRYPTION_KEY, VERIFICATION_TOKEN, connectorRow } from "./test-support";
import type { Actor } from "@/lib/auth/guard";

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connector secrets", () => {
  it("round-trips through AES-GCM and the ciphertext reveals nothing", () => {
    const enc = encryptSecrets({ appSecret: APP_SECRET, verificationToken: VERIFICATION_TOKEN, encryptKey: "ek-789" });
    expect(enc.split(".")).toHaveLength(3);
    expect(enc).not.toContain(APP_SECRET);
    expect(decryptSecrets(enc)).toEqual({
      appSecret: APP_SECRET,
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: "ek-789",
    });
  });

  it("normalises an absent encrypt key to null", () => {
    const enc = encryptSecrets({ appSecret: "a", verificationToken: "b" });
    expect(decryptSecrets(enc).encryptKey).toBeNull();
  });

  it("rejects a blob that decrypts but is not a secrets object", async () => {
    const { encrypt } = await import("@/lib/crypto");
    expect(() => decryptSecrets(encrypt(JSON.stringify({ nope: true })))).toThrow(/malformed/i);
  });

  it("secretsView exposes presence booleans only — never a value or a fragment", () => {
    const withKey = secretsView(encryptSecrets({ appSecret: APP_SECRET, verificationToken: VERIFICATION_TOKEN, encryptKey: "ek-789" }));
    expect(withKey).toEqual({
      has_app_secret: true,
      has_verification_token: true,
      has_encrypt_key: true,
      secrets_readable: true,
    });
    const without = secretsView(encryptSecrets({ appSecret: APP_SECRET, verificationToken: VERIFICATION_TOKEN }));
    expect(without.has_encrypt_key).toBe(false);
    expect(JSON.stringify(withKey)).not.toContain(APP_SECRET);
  });

  it("secretsView degrades to secrets_readable=false when the key is wrong, without throwing", () => {
    const enc = encryptSecrets({ appSecret: APP_SECRET, verificationToken: VERIFICATION_TOKEN });
    vi.stubEnv("NOPM_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    expect(secretsView(enc)).toEqual({
      has_app_secret: false,
      has_verification_token: false,
      has_encrypt_key: false,
      secrets_readable: false,
    });
  });
});

describe("relay secret", () => {
  it("is shown once as a raw value; only sha-256 is derived for storage", () => {
    const { raw, hash } = generateRelaySecret();
    expect(raw).toMatch(/^npr_[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(hash).toBe(hashRelaySecret(raw));
    expect(hash).not.toContain(raw);
  });

  it("two secrets never collide", () => {
    expect(generateRelaySecret().raw).not.toBe(generateRelaySecret().raw);
  });

  it("relayHmacKey is the stored hash, null when the connector has none", () => {
    expect(relayHmacKey({ relay_secret_hash: "abc" })).toBe("abc");
    expect(relayHmacKey({ relay_secret_hash: null })).toBeNull();
  });
});

describe("safeEqual", () => {
  it("compares equal / different / different-length strings correctly", () => {
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "diff")).toBe(false);
    expect(safeEqual("short", "a much longer value")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("sanitizeError", () => {
  it("redacts known secrets, bearer tokens and token-shaped values", () => {
    const text = sanitizeError(
      new Error(`401 using ${APP_SECRET} Authorization: Bearer abc.def-123 and npa_ABCDEFGH12345678`),
      [APP_SECRET],
    );
    expect(text).not.toContain(APP_SECRET);
    expect(text).not.toContain("abc.def-123");
    expect(text).not.toContain("npa_ABCDEFGH12345678");
    expect(text).toContain("[redacted]");
  });

  it("truncates to 300 characters and collapses whitespace", () => {
    const text = sanitizeError("x\n\n   y ".repeat(200));
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).not.toMatch(/\s{2,}/);
  });

  it("copes with non-error inputs", () => {
    expect(sanitizeError(undefined)).toBe("Unknown error");
    expect(sanitizeError("plain string")).toBe("plain string");
  });

  it("ignores very short 'secrets' so it cannot shred ordinary text", () => {
    expect(sanitizeError("the abc value", ["abc"])).toBe("the abc value");
  });
});

describe("store helpers", () => {
  it("toPublicConnector returns presence flags + non-secret config, never ciphertext or the relay hash", () => {
    const view = toPublicConnector(connectorRow());
    const json = JSON.stringify(view);
    expect(view).toMatchObject({
      kind: "lark",
      status: "active",
      region: "lark",
      app_id: "cli_a1b2c3",
      has_app_secret: true,
      has_verification_token: true,
      has_encrypt_key: false,
      has_relay_secret: true,
      secrets_readable: true,
    });
    expect(json).not.toContain(APP_SECRET);
    expect(json).not.toContain("secret_enc");
    expect(json).not.toContain("relay_secret_hash");
    expect(json).not.toContain("relayhash");
  });

  it("normalizeConfig fills defaults for a sparse / malformed jsonb", () => {
    expect(normalizeConfig(null)).toEqual({
      region: "lark",
      appId: "",
      mode: "webhook",
      approvals: { enabled: true },
      digest: { enabled: false, chatId: null, weekday: 1 },
    });
    expect(normalizeConfig({ region: "feishu", digest: { enabled: true, chatId: "oc_x", weekday: 9 } }).digest).toEqual({
      enabled: true,
      chatId: "oc_x",
      weekday: 1, // out-of-range weekday falls back
    });
  });

  it("assertIntegrationAdmin allows only a signed-in admin", () => {
    const base: Actor = { type: "user", id: "u", label: "u", workspaceId: "w", role: "admin" };
    expect(() => assertIntegrationAdmin(base)).not.toThrow();
    expect(() => assertIntegrationAdmin({ ...base, role: "manager" })).toThrow(/admin/);
    expect(() => assertIntegrationAdmin({ ...base, type: "token", scopes: ["*"] })).toThrow(/admin/);
  });

  it("appBaseUrl prefers NEXT_PUBLIC_APP_URL and strips trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pm.example.test/");
    expect(appBaseUrl("http://localhost:3000")).toBe("https://pm.example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(appBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(appBaseUrl()).toBe("");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "pm-app.vercel.example");
    expect(appBaseUrl()).toBe("https://pm-app.vercel.example");
    expect(appBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });
});

describe("sanitizeError — every secret family in the repo", () => {
  const families: [string, () => string][] = [
    ["npm_ personal access token", () => generateToken().raw],
    ["npa_ card action token", () => deriveActionToken("d-1", "npa_").raw],
    ["npr_ relay secret", () => generateRelaySecret().raw],
    ["npi_ invite token", () => generateToken("npi_").raw],
    ["npc_ calendar feed token", () => generateFeedToken().raw],
    ["NPL- identity link code", () => generateLinkCode()],
    ["Lark tenant access token", () => "t-g1048abcdefghijklmnopqrstuv"],
  ];

  it.each(families)("redacts a %s wherever it is quoted", (_label, make) => {
    const secret = make();
    const text = sanitizeError(new Error(`GET https://pm.example.test/api/calendar/${secret}.ics failed; token=${secret}`));
    expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
  });

  it("redacts a calendar token even when it sits at the very start of a long message", () => {
    const secret = generateFeedToken().raw;
    expect(sanitizeError(`${secret} ${"x".repeat(400)}`)).not.toContain(secret.slice(0, 20));
  });

  it("follows a custom NOPM_TOKEN_PREFIX for PATs", async () => {
    vi.resetModules();
    vi.stubEnv("NOPM_TOKEN_PREFIX", "xz_");
    const fresh = await import("./secrets");
    const tokens = await import("@/lib/auth/tokens");
    const raw = tokens.generateToken().raw;
    expect(raw.startsWith("xz_")).toBe(true);
    expect(fresh.sanitizeError(`bad token ${raw}`)).not.toContain(raw);
    vi.resetModules();
  });

  it("leaves ordinary text that merely resembles a prefix alone", () => {
    expect(sanitizeError("t-shirt sizes and npm_ are fine, so is NPL-ABC")).toBe("t-shirt sizes and npm_ are fine, so is NPL-ABC");
  });
});

describe("deriveActionToken", () => {
  it("is deterministic per delivery id and differs between deliveries", () => {
    expect(deriveActionToken("delivery-1", "npa_")).toEqual(deriveActionToken("delivery-1", "npa_"));
    expect(deriveActionToken("delivery-1", "npa_").raw).not.toBe(deriveActionToken("delivery-2", "npa_").raw);
  });

  it("has the same shape a random token has, and hashes with sha-256 like every other token", () => {
    const { raw, hash } = deriveActionToken("delivery-1", "npa_");
    expect(raw).toMatch(/^npa_[A-Za-z0-9_-]{32}$/);
    expect(hash).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("depends on the server's encryption key, so the delivery id alone cannot reproduce it", () => {
    const before = deriveActionToken("delivery-1", "npa_").raw;
    vi.stubEnv("NOPM_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    expect(deriveActionToken("delivery-1", "npa_").raw).not.toBe(before);
  });

  it("refuses to mint without a usable key (a missing key must never yield a guessable token)", () => {
    vi.stubEnv("NOPM_ENCRYPTION_KEY", "");
    expect(() => deriveActionToken("delivery-1", "npa_")).toThrow(/NOPM_ENCRYPTION_KEY/);
    vi.stubEnv("NOPM_ENCRYPTION_KEY", Buffer.alloc(16, 1).toString("base64"));
    expect(() => deriveActionToken("delivery-1", "npa_")).toThrow(/NOPM_ENCRYPTION_KEY/);
  });
});

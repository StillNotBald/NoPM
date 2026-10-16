import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import type { LarkSecrets } from "@/lib/integrations/types";

/**
 * Connector secret handling (Integration Hub).
 *
 * - App credentials (`LarkSecrets`) are AES-256-GCM encrypted as ONE JSON blob
 *   in `integration_connectors.secret_enc` via src/lib/crypto.ts — the same
 *   at-rest scheme as the BYOK assistant key. They are decrypted only inside
 *   the server process that is about to call the platform or verify a
 *   callback, and are never returned by any API or written to a log/audit row.
 * - The RELAY secret (self-host worker -> app HMAC) is generated server-side,
 *   shown to the admin exactly once and stored only as a SHA-256 hash, like
 *   an API token. An HMAC verifier needs a key, and the server no longer has
 *   the raw secret — so the HMAC KEY both sides use is `hashRelaySecret(raw)`
 *   (lowercase hex of sha256(raw)): the worker derives it from the raw secret
 *   it was given, the app reads it from `integration_connectors.relay_secret_hash`
 *   (`relayHmacKey`). Knowing the hash is not enough to act: a forged relay
 *   event still needs a linked platform identity and a single-use action token
 *   whose raw value is never stored.
 */

export const RELAY_SECRET_PREFIX = "npr_";

export function encryptSecrets(secrets: LarkSecrets): string {
  return encrypt(
    JSON.stringify({
      appSecret: secrets.appSecret,
      verificationToken: secrets.verificationToken,
      encryptKey: secrets.encryptKey ?? null,
    }),
  );
}

/** Decrypt + shape-check a stored blob. Throws on a wrong key / corrupt data. */
export function decryptSecrets(secretEnc: string): LarkSecrets {
  const parsed = JSON.parse(decrypt(secretEnc)) as Partial<LarkSecrets> | null;
  if (!parsed || typeof parsed.appSecret !== "string" || typeof parsed.verificationToken !== "string") {
    throw new Error("Connector secrets are malformed");
  }
  return {
    appSecret: parsed.appSecret,
    verificationToken: parsed.verificationToken,
    encryptKey: typeof parsed.encryptKey === "string" && parsed.encryptKey ? parsed.encryptKey : null,
  };
}

/** What an API may say about the secrets: presence only, never a value or a fragment. */
export type SecretsView = {
  has_app_secret: boolean;
  has_verification_token: boolean;
  has_encrypt_key: boolean;
  /** False when the blob cannot be decrypted (key missing / rotated / corrupt). */
  secrets_readable: boolean;
};

export function secretsView(secretEnc: string): SecretsView {
  try {
    const s = decryptSecrets(secretEnc);
    return {
      has_app_secret: s.appSecret.length > 0,
      has_verification_token: s.verificationToken.length > 0,
      has_encrypt_key: !!s.encryptKey,
      secrets_readable: true,
    };
  } catch {
    return { has_app_secret: false, has_verification_token: false, has_encrypt_key: false, secrets_readable: false };
  }
}

export function hashRelaySecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * The HMAC key for verifying relayed events: the stored hash (hex string).
 * Null when the connector has no relay secret (webhook-mode connector).
 */
export function relayHmacKey(connector: { relay_secret_hash: string | null }): string | null {
  return connector.relay_secret_hash || null;
}

/** 256-bit relay secret, shown once. Only its SHA-256 is persisted. */
export function generateRelaySecret(): { raw: string; hash: string } {
  const raw = `${RELAY_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashRelaySecret(raw) };
}

/**
 * Constant-time string comparison that is also length-safe: both sides are
 * hashed first so `timingSafeEqual` always sees equal-length buffers and the
 * length of the secret is not leaked through an early return.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const MAX_ERROR_LENGTH = 300;

/**
 * Make an arbitrary error safe to persist in `integration_deliveries.last_error`
 * or return to an admin: redact any known secret value and bearer-style
 * tokens, collapse whitespace, truncate. Message bodies are never stored.
 */
export function sanitizeError(err: unknown, knownSecrets: (string | null | undefined)[] = []): string {
  let text = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) text = text.split(secret).join("[redacted]");
  }
  text = text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\b(?:npa|npr|npm|npi)_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text || "Unknown error";
}

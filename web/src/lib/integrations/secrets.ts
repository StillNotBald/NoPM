import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import { TOKEN_PREFIX } from "@/lib/auth/tokens";
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

/**
 * The per-delivery action token a card carries. DERIVED, not random: an HMAC of
 * the delivery id under the server's encryption key. The raw value is never
 * stored (only its SHA-256 is), yet a retry of the SAME delivery can recompute
 * it, so one delivery has exactly one token however many times it is attempted,
 * and a retried send carries the same card as the first. (A random token per
 * attempt left up to six live tokens for one card, and made every retry a
 * different message, which defeats the platform's idempotency key.)
 *
 * 192 bits of HMAC output, base64url, the same shape and entropy a random
 * `generateToken()` value has. Forging one needs the encryption key, which
 * already unlocks every connector credential; and a token on its own decides
 * nothing: the inbound pipeline still requires a verified, linked platform
 * identity that is the token's bound recipient.
 */
export function deriveActionToken(deliveryId: string, prefix: string): { raw: string; hash: string } {
  const key = Buffer.from(process.env.NOPM_ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("NOPM_ENCRYPTION_KEY is not configured");
  const body = createHmac("sha256", key)
    .update(`nopm:action-token:v1:${deliveryId}`)
    .digest()
    .subarray(0, 24)
    .toString("base64url");
  const raw = `${prefix}${body}`;
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

const MAX_ERROR_LENGTH = 300;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every secret-bearing prefix in the repo: `npm_` PATs (the family prefix is
 * env-configurable, so it is read from the same constant the minting code
 * uses), `npa_` card action tokens, `npr_` relay secrets, `npi_` invites and
 * `npc_` calendar feed tokens (those travel in a URL, which is exactly what an
 * HTTP client error likes to quote). A new token family must be added here.
 */
const SECRET_TOKEN_PATTERN = new RegExp(
  `\\b(?:${["npa_", "npr_", "npi_", "npc_", "npm_", TOKEN_PREFIX].map(escapeRegExp).join("|")})[A-Za-z0-9_-]{8,}`,
  "g",
);
/** Identity link codes: `NPL-XXXX-XXXX` (dashes optional, as the parser accepts them). */
const LINK_CODE_PATTERN = /\bNPL-?[A-Z2-9]{4}-?[A-Z2-9]{4}\b/gi;
/** Lark tenant / user access tokens (`t-...`, `u-...`) when quoted outside an Authorization header. */
const PLATFORM_TOKEN_PATTERN = /\b[tu]-[A-Za-z0-9]{20,}\b/g;

/**
 * Make an arbitrary error safe to persist in `integration_deliveries.last_error`
 * or return to an admin: redact any known secret value, every token family
 * above and bearer-style tokens, collapse whitespace, truncate. Message bodies
 * are never stored.
 */
export function sanitizeError(err: unknown, knownSecrets: (string | null | undefined)[] = []): string {
  let text = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) text = text.split(secret).join("[redacted]");
  }
  text = text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(SECRET_TOKEN_PATTERN, "[redacted]")
    .replace(LINK_CODE_PATTERN, "[redacted]")
    .replace(PLATFORM_TOKEN_PATTERN, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text || "Unknown error";
}

import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";

/**
 * GitHub connector secret (R-153): the webhook signing secret. An HMAC verifier needs the raw key, so
 * it is stored as AES-256-GCM ciphertext in `integration_connectors.secret_enc` (the Lark scheme),
 * decrypted only inside the process verifying a delivery, shown to the admin once, never returned by an API.
 */

export const GITHUB_SECRET_PREFIX = "npg_";

export function generateWebhookSecret(): string {
  return `${GITHUB_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function encryptWebhookSecret(secret: string): string {
  return encrypt(JSON.stringify({ webhookSecret: secret }));
}

/** Throws on a wrong key or a corrupt / foreign blob. */
export function decryptWebhookSecret(secretEnc: string): string {
  const parsed = JSON.parse(decrypt(secretEnc)) as { webhookSecret?: unknown } | null;
  if (!parsed || typeof parsed.webhookSecret !== "string" || !parsed.webhookSecret) {
    throw new Error("GitHub connector secret is malformed");
  }
  return parsed.webhookSecret;
}

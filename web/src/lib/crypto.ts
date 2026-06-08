/**
 * AES-256-GCM encrypt/decrypt helpers.
 * Key is sourced from NOPM_ENCRYPTION_KEY (base64-encoded 32 bytes).
 *
 * Packed format: <iv_b64>.<authTag_b64>.<ciphertext_b64>  (three dot-separated segments)
 *
 * The key check and any throws live INSIDE the functions so that next build
 * succeeds even when the env var is absent at build time.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV — GCM standard
const TAG_BYTES = 16;

function loadKey(): Buffer {
  const raw = process.env.NOPM_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "NOPM_ENCRYPTION_KEY is not set. Provide a base64-encoded 32-byte key.",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `NOPM_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}).`,
    );
  }
  return buf;
}

/**
 * Encrypt a plaintext string.
 * Returns a dot-joined payload: `<iv_b64>.<authTag_b64>.<ciphertext_b64>`.
 */
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a payload produced by `encrypt`.
 * Throws if the payload is malformed or the auth tag verification fails.
 */
export function decrypt(payload: string): string {
  const key = loadKey();
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload: expected 3 dot-separated segments.");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");

  if (iv.length !== IV_BYTES) {
    throw new Error(`Invalid IV length: expected ${IV_BYTES} bytes.`);
  }
  if (authTag.length !== TAG_BYTES) {
    throw new Error(`Invalid auth tag length: expected ${TAG_BYTES} bytes.`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

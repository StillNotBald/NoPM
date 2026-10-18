import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook authenticity (R-153): `X-Hub-Signature-256: sha256=<hex>` is the HMAC-SHA256 of the
 * RAW request body under the webhook secret. Compared in constant time over equal-length buffers.
 */

export function signGithubBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

export function verifyGithubSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = Buffer.from(signGithubBody(rawBody, secret), "utf8");
  const given = Buffer.from(header.toLowerCase(), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Lark / Feishu webhook authenticity: signature, decryption, token.
 *
 * Pure (no I/O, no DB) so it is reusable by the hosted webhook routes and by
 * any relay that has to re-check a platform payload.
 *
 * ── What was VERIFIED, and where ──────────────────────────────────────────
 * Checked against the pinned SDK source (`@larksuiteoapi/node-sdk` 1.74.0,
 * `lib/index.js`: `AESCipher`, `RequestHandle`, `generateChallenge`) and the
 * official event-subscription security page (open.feishu.cn →
 * server-docs/event-subscription-guide/event-subscription-configure-/
 * encrypt-key-encryption-configuration-case):
 *   • Signature headers: `X-Lark-Request-Timestamp`, `X-Lark-Request-Nonce`,
 *     `X-Lark-Signature` (SDK `RequestHandle.checkIsEventValidated`; docs).
 *   • Signature = lowercase-hex SHA-256 of `timestamp + nonce + encryptKey +
 *     body`. The docs are explicit that `body` is the RAW request body, "not
 *     recomputed after deserialization". (The SDK re-stringifies the parsed
 *     object, which only works when the sender's JSON is already compact; we
 *     hash the raw bytes as the docs say.)
 *   • Encryption: body is `{"encrypt":"<base64>"}`; AES-256-CBC, key =
 *     SHA-256(encryptKey), IV = first 16 bytes of the decoded payload,
 *     ciphertext = the rest, PKCS#7 padding (SDK `AESCipher.decrypt`; docs'
 *     Node/Python/PHP samples). The decrypted text is the event JSON.
 *   • Verification token: schema-2.0 events carry it at `header.token`,
 *     legacy / `url_verification` bodies at top-level `token` (SDK
 *     `generateChallenge`, docs card + form examples).
 *   • `url_verification` body is `{ challenge, token, type:"url_verification" }`
 *     and the reply is `{ challenge }` (SDK `generateChallenge`).
 *   • The SDK does NOT compare the verification token for events at all
 *     (`checkIsEventValidated` returns true when no encryptKey is set), so
 *     we do it ourselves, in constant time.
 *   • Card JSON 2.0 callbacks (`schema: "2.0"`, `event_type:
 *     "card.action.trigger"`) are routed through the SAME event validator
 *     in the SDK (`checkIsCardEventValidated` → `checkIsEventValidated`
 *     when `'schema' in data`), i.e. the same signature scheme + header
 *     token. The card-callback docs page itself documents `header.token`
 *     only and says nothing about the signature.
 *
 * ── What is ASSUMED ───────────────────────────────────────────────────────
 *   • `X-Lark-Request-Timestamp` is epoch SECONDS (we also tolerate ms). The
 *     docs specify no tolerance window; the ±5 min window is our own replay
 *     guard (PLAN hard rule), not a platform rule.
 *   • Whether Lark signs the one-off `url_verification` request when an
 *     Encrypt Key is configured is not documented: for that single request
 *     type the signature is checked when present but not required (the
 *     token check, inside the decrypted body, is mandatory and echoes
 *     nothing but the challenge).
 *   • Without an Encrypt Key there is no signature at all (docs tie the
 *     signature to the Encrypt Key), so authenticity rests on the verification
 *     token alone — Lark's own docs warn that it then travels in plaintext.
 *     Setting an Encrypt Key is strongly recommended for any real tenant.
 *
 * Failure reasons are for server-side logs only. Callers must NOT surface
 * them to the requester (one generic 401), so the response never becomes a
 * decryption / token oracle.
 */

import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

/** Replay window for the signed timestamp (PLAN hard rule: ±5 minutes). */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Largest webhook body we will even try to parse (events are well under 100 KB). */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export type LarkEnvelope = {
  /** "2.0" for schema-2.0 events and card callbacks. */
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
    app_id?: string;
    tenant_key?: string;
    create_time?: string;
  };
  event?: Record<string, unknown>;
  /** `url_verification` handshake / legacy v1 shape. */
  type?: string;
  challenge?: string;
  token?: string;
  [key: string]: unknown;
};

export type VerifyFailure =
  | "bad_json"
  | "encryption_not_configured"
  | "decrypt_failed"
  | "missing_signature"
  | "stale_timestamp"
  | "bad_signature"
  | "bad_token";

export type VerifyResult =
  | { ok: true; envelope: LarkEnvelope; encrypted: boolean }
  | { ok: false; reason: VerifyFailure };

type HeaderSource = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }
  return null;
}

/**
 * Constant-time string equality that does not leak length: both sides are
 * hashed to 32 bytes first, so `timingSafeEqual` always compares equal-length
 * buffers.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Lowercase-hex SHA-256 of `timestamp + nonce + encryptKey + rawBody`. */
export function computeLarkSignature(input: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  rawBody: string;
}): string {
  return createHash("sha256")
    .update(input.timestamp + input.nonce + input.encryptKey + input.rawBody, "utf8")
    .digest("hex");
}

/** Decrypt a `{ "encrypt": "<base64>" }` payload. Throws on any malformed input. */
export function decryptLarkPayload(encrypt: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const buf = Buffer.from(encrypt, "base64");
  // IV (16) + at least one AES block (16); CBC ciphertext is block-aligned.
  if (buf.length < 32 || (buf.length - 16) % 16 !== 0) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString("utf8");
}

function timestampToMs(raw: string): number | null {
  if (!/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? n : n * 1000;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type VerifyInput = {
  rawBody: string;
  headers: HeaderSource;
  secrets: { verificationToken: string; encryptKey?: string | null };
  /** Injected clock for tests. */
  now?: () => number;
  toleranceMs?: number;
};

/**
 * Authenticate a Lark/Feishu webhook request and return the plaintext event
 * envelope. Order matters: the OUTER request is authenticated by signature
 * before any ciphertext is decrypted, then the verification token inside the
 * (decrypted) body is compared in constant time.
 */
export function verifyLarkRequest(input: VerifyInput): VerifyResult {
  const { rawBody, headers, secrets } = input;
  const now = input.now ?? Date.now;
  const tolerance = input.toleranceMs ?? SIGNATURE_TOLERANCE_MS;
  const encryptKey = secrets.encryptKey?.trim() || "";
  const verificationToken = secrets.verificationToken?.trim() || "";

  const outer = parseObject(rawBody);
  if (!outer) return { ok: false, reason: "bad_json" };

  const timestamp = readHeader(headers, "x-lark-request-timestamp");
  const nonce = readHeader(headers, "x-lark-request-nonce");
  const signature = readHeader(headers, "x-lark-signature");
  const hasSignatureHeaders = Boolean(timestamp && nonce && signature);

  // 1. Authenticate the outer request when an Encrypt Key is configured.
  let signatureChecked = false;
  if (encryptKey && hasSignatureHeaders) {
    const tsMs = timestampToMs(timestamp as string);
    if (tsMs === null || Math.abs(now() - tsMs) > tolerance) return { ok: false, reason: "stale_timestamp" };
    const expected = computeLarkSignature({
      timestamp: timestamp as string,
      nonce: nonce as string,
      encryptKey,
      rawBody,
    });
    if (!safeEqual(expected, (signature as string).trim().toLowerCase())) return { ok: false, reason: "bad_signature" };
    signatureChecked = true;
  }

  // 2. Decrypt, if the platform encrypted the body.
  let envelope: Record<string, unknown> = outer;
  const encrypted = typeof outer.encrypt === "string";
  if (encrypted) {
    if (!encryptKey) return { ok: false, reason: "encryption_not_configured" };
    const plaintext = (() => {
      try {
        return decryptLarkPayload(outer.encrypt as string, encryptKey);
      } catch {
        return null;
      }
    })();
    const inner = plaintext === null ? null : parseObject(plaintext);
    if (!inner) return { ok: false, reason: "decrypt_failed" };
    // Anything outside `encrypt` in the outer object is unauthenticated: ignore it.
    envelope = inner;
  }

  const isChallenge = envelope.type === "url_verification";

  // 3. With an Encrypt Key, every request except the one-off handshake MUST be signed.
  if (encryptKey && !signatureChecked && !isChallenge) return { ok: false, reason: "missing_signature" };

  // 4. Verification token: mandatory, constant-time, fail-closed when unset.
  const header = envelope.header && typeof envelope.header === "object" ? (envelope.header as Record<string, unknown>) : null;
  const presented =
    typeof header?.token === "string" ? header.token : typeof envelope.token === "string" ? envelope.token : "";
  if (!verificationToken || !presented || !safeEqual(presented, verificationToken)) {
    return { ok: false, reason: "bad_token" };
  }

  return { ok: true, envelope: envelope as LarkEnvelope, encrypted };
}

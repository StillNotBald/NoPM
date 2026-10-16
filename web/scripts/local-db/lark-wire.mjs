// NoPM local-DB probes — the Lark/Feishu wire format, built with node:crypto only.
//
// A SEPARATE implementation of the documented scheme from the one the app uses
// (src/lib/integrations/lark/verify.ts), on purpose: if the probe and the app
// agreed only because they share code, a mistake in the scheme would pass
// silently. The scheme (event-subscription security page of the platform docs):
//   body      = {"encrypt": base64( iv(16) || AES-256-CBC(plaintext) )}, key = SHA-256(encryptKey)
//   signature = lowercase hex SHA-256( timestamp + nonce + encryptKey + rawBody )
//   headers   = X-Lark-Request-Timestamp (epoch seconds), X-Lark-Request-Nonce, X-Lark-Signature
//   token     = the app's verification token, at header.token inside the plaintext (schema 2.0)
//
// Nothing here talks to the network. The relay transport (self-host worker ->
// app) is signed differently; see relaySign() at the bottom (mirrors
// src/lib/integrations/lark/relay.ts, written independently here).
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export function encryptBody(plaintext, encryptKey) {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({ encrypt: Buffer.concat([iv, ct]).toString("base64") });
}

export function signHeaders({ rawBody, encryptKey, timestamp, nonce }) {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const n = nonce ?? randomBytes(8).toString("hex");
  const signature = createHash("sha256").update(ts + n + encryptKey + rawBody, "utf8").digest("hex");
  return {
    "content-type": "application/json",
    "x-lark-request-timestamp": ts,
    "x-lark-request-nonce": n,
    "x-lark-signature": signature,
  };
}

/** A schema-2.0 `card.action.trigger` callback (a click on a card button). */
export function cardActionEnvelope({ eventId, verificationToken, appId, tenantKey, openId, actionToken, action, formValue }) {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "card.action.trigger",
      create_time: String(Date.now() * 1000),
      token: verificationToken,
      app_id: appId,
      tenant_key: tenantKey,
    },
    event: {
      operator: { tenant_key: tenantKey, user_id: "u_probe", open_id: openId },
      token: `c-probe-${eventId}`,
      action: {
        // The card carries ONLY the raw action token and the verb — nothing else is trusted.
        value: { t: actionToken, a: action },
        tag: "button",
        timezone: "Asia/Kuala_Lumpur",
        ...(formValue ? { form_value: formValue } : {}),
      },
      host: "im_message",
      context: { open_message_id: "om_probe_card", open_chat_id: "oc_probe_dm" },
    },
  };
}

/**
 * The request a Lark delivery would make for `envelope`: encrypted body +
 * signature headers. `tamper` lets a test corrupt exactly one thing.
 */
export function buildWebhookRequest(envelope, { encryptKey, timestamp, tamper } = {}) {
  let rawBody = encryptBody(JSON.stringify(envelope), encryptKey);
  const headers = signHeaders({ rawBody, encryptKey, timestamp });
  if (tamper === "signature") headers["x-lark-signature"] = headers["x-lark-signature"].replace(/^./, (c) => (c === "0" ? "1" : "0"));
  if (tamper === "body") {
    // Flip a ciphertext byte AFTER signing: the signature no longer matches the bytes on the wire.
    const o = JSON.parse(rawBody);
    const buf = Buffer.from(o.encrypt, "base64");
    buf[buf.length - 1] ^= 0x01;
    rawBody = JSON.stringify({ encrypt: buf.toString("base64") });
  }
  return { rawBody, headers };
}

// ── self-host relay transport (worker -> app) ─────────────────────────────
// X-NoPM-Relay-Timestamp: <epoch seconds>
// X-NoPM-Relay-Signature: v1=<hex HMAC-SHA256(key, timestamp + "." + rawBody)>
// key = lowercase hex SHA-256 of the RAW relay secret (the server only stores that hash).
export function relayHeaders(rawRelaySecret, rawBody, timestamp) {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const key = createHash("sha256").update(rawRelaySecret).digest("hex");
  const sig = createHmac("sha256", key).update(`${ts}.${rawBody}`).digest("hex");
  return {
    "content-type": "application/json",
    "x-nopm-relay-timestamp": ts,
    "x-nopm-relay-signature": `v1=${sig}`,
  };
}

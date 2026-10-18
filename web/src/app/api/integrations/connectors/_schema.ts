import { z } from "zod";

/**
 * Request bodies for the connector management routes (admin only). Snake_case
 * on the wire like the rest of the REST contract; the routes map it onto the
 * camelCase `LarkConfig` / `LarkSecrets` shapes stored by the hub.
 *
 * Secrets (`app_secret`, `verification_token`, `encrypt_key`) are accepted on
 * create/update and are NEVER echoed back by any response.
 */

const appId = z
  .string()
  .trim()
  .min(1, "app_id is required")
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "app_id may only contain letters, digits, '-' and '_'");

const chatId = z
  .string()
  .trim()
  .regex(/^oc_[A-Za-z0-9]+$/, "chat_id must be a Lark group chat id (oc_…)");

const secretValue = z.string().min(1, "must not be empty").max(512);

/**
 * Webhook mode makes the Lark-facing URLs public. Without an Encrypt Key the
 * only proof an event came from Lark is the verification token, which sits in
 * clear text in every event body and is visible to every collaborator on the
 * Lark app: anyone holding it could fake bot messages. With the key every
 * event is signed and encrypted. Long-connection mode never exposes a public
 * URL (events arrive over the worker's outbound connection), so it may omit it.
 */
export const ENCRYPT_KEY_REQUIRED_MESSAGE =
  "encrypt_key is required in webhook mode: it signs and encrypts the events Lark sends to your public URL. Copy the Encrypt Key from the Lark app's Events & Callbacks page. Long-connection mode does not need one.";

const weekday = z.number().int().min(0, "weekday is 0 (Sunday) to 6 (Saturday)").max(6, "weekday is 0 (Sunday) to 6 (Saturday)");

export const createConnectorSchema = z
  .object({
    kind: z.literal("lark").default("lark"),
    name: z.string().trim().min(1, "name is required").max(100),
    region: z.enum(["lark", "feishu"], { error: "region must be 'lark' or 'feishu'" }),
    app_id: appId,
    app_secret: secretValue,
    verification_token: secretValue,
    encrypt_key: secretValue.nullish(),
    mode: z.enum(["webhook", "long_connection"], { error: "mode must be 'webhook' or 'long_connection'" }).default("webhook"),
    approvals: z.object({ enabled: z.boolean() }).default({ enabled: true }),
    digest: z
      .object({
        enabled: z.boolean(),
        chat_id: chatId.nullish(),
        weekday: weekday.default(1),
      })
      .default({ enabled: false, chat_id: null, weekday: 1 }),
  })
  .refine((v) => !v.digest.enabled || !!v.digest.chat_id, {
    message: "digest.chat_id is required when the digest is enabled",
    path: ["digest", "chat_id"],
  })
  .refine((v) => v.mode !== "webhook" || !!v.encrypt_key, {
    message: ENCRYPT_KEY_REQUIRED_MESSAGE,
    path: ["encrypt_key"],
  });

export const updateConnectorSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    /** active <-> paused only; revoking is DELETE. */
    status: z.enum(["active", "paused"], { error: "status must be 'active' or 'paused'" }).optional(),
    region: z.enum(["lark", "feishu"], { error: "region must be 'lark' or 'feishu'" }).optional(),
    app_id: appId.optional(),
    app_secret: secretValue.optional(),
    verification_token: secretValue.optional(),
    /** null clears the encrypt key. */
    encrypt_key: secretValue.nullable().optional(),
    mode: z.enum(["webhook", "long_connection"], { error: "mode must be 'webhook' or 'long_connection'" }).optional(),
    approvals: z.object({ enabled: z.boolean() }).optional(),
    digest: z
      .object({
        enabled: z.boolean().optional(),
        chat_id: chatId.nullable().optional(),
        weekday: weekday.optional(),
      })
      .optional(),
    /** Clears the tenant pin so the connector can be re-pinned by the next first link. */
    clear_tenant_pin: z.boolean().optional(),
    /** Generates a new relay secret (returned once) and invalidates the old one. */
    rotate_relay_secret: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });

export type CreateConnectorInput = z.infer<typeof createConnectorSchema>;
export type UpdateConnectorInput = z.infer<typeof updateConnectorSchema>;

import { randomBytes } from "node:crypto";
import { encryptSecrets, decryptSecrets } from "@/lib/integrations/secrets";
import type { ConnectorRow } from "@/lib/integrations/types";

/**
 * Telegram connector secrets reuse the hub's encrypted blob: the bot token is
 * stored in the `appSecret` slot and the webhook secret token in the
 * `verificationToken` slot. Nothing here is ever returned by an API or logged.
 */
export type TelegramSecrets = { botToken: string; webhookSecret: string };

export function encryptTelegramSecrets(s: TelegramSecrets): string {
  return encryptSecrets({ appSecret: s.botToken, verificationToken: s.webhookSecret, encryptKey: null });
}

/** Throws on a missing or rotated key, or a corrupt blob. */
export function readTelegramSecrets(connector: Pick<ConnectorRow, "secret_enc">): TelegramSecrets {
  const s = decryptSecrets(connector.secret_enc);
  return { botToken: s.appSecret, webhookSecret: s.verificationToken };
}

/** 64 hex characters: inside the Bot API's A-Z a-z 0-9 _ - alphabet, 1-256 long. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function webhookUrl(base: string, connectorId: string): string {
  return `${base.replace(/\/+$/, "")}/api/integrations/telegram/${connectorId}/webhook`;
}

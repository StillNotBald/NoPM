/**
 * Registering a Telegram connector with the Bot API: the webhook (with the
 * per-connector secret token) and the command menu. The default scope carries
 * the member menu; a role whose menu differs gets a per-chat scope once the
 * person has linked (`registerChatMenu`).
 */

import type { ConnectorRow } from "@/lib/integrations/types";
import { commandList, menuDiffersFromDefault, type Role } from "./commands";
import { deleteMyCommands, deleteWebhook, getMe, setMyCommands, setWebhook, type TgResult } from "./http";
import { readTelegramSecrets, webhookUrl } from "./secrets";

export type SetupResult = { ok: true; botUsername: string | null } | { ok: false; step: "token" | "webhook" | "menu"; error: string };

/** Cheap credential check: asks Telegram who the bot is. */
export async function testTelegram(botToken: string): Promise<{ ok: true; username: string | null } | { ok: false; error: string }> {
  const me = await getMe(botToken);
  if (!me.ok) return { ok: false, error: me.error };
  return { ok: true, username: me.result.username ?? null };
}

/** setWebhook + setMyCommands (default scope). Does not throw. */
export async function registerTelegram(connector: ConnectorRow, appBase: string): Promise<SetupResult> {
  let secrets;
  try {
    secrets = readTelegramSecrets(connector);
  } catch {
    return { ok: false, step: "token", error: "Stored credentials cannot be decrypted. Paste the bot token again." };
  }
  const me = await getMe(secrets.botToken);
  if (!me.ok) return { ok: false, step: "token", error: me.error };
  const hook = await setWebhook(secrets.botToken, webhookUrl(appBase, connector.id), secrets.webhookSecret);
  if (!hook.ok) return { ok: false, step: "webhook", error: hook.error };
  const menu = await setMyCommands(secrets.botToken, commandList("member"), { type: "default" });
  if (!menu.ok) return { ok: false, step: "menu", error: menu.error };
  return { ok: true, botUsername: me.result.username ?? null };
}

/** Per-chat command scope for a linked person whose menu differs from the default. */
export async function registerChatMenu(connector: ConnectorRow, chatId: string, role: Role): Promise<TgResult | null> {
  const { botToken } = readTelegramSecrets(connector);
  const scope = { type: "chat", chat_id: Number(chatId) } as const;
  if (!menuDiffersFromDefault(role)) return deleteMyCommands(botToken, scope);
  return setMyCommands(botToken, commandList(role), scope);
}

/** Best effort on disconnect: stop Telegram calling us. */
export async function removeWebhook(connector: ConnectorRow): Promise<void> {
  try {
    await deleteWebhook(readTelegramSecrets(connector).botToken);
  } catch {
    // The token is erased next either way.
  }
}

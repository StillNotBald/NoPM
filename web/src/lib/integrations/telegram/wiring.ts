/**
 * Production bindings for the Telegram handlers: the one file that connects the
 * transport-agnostic code (./handlers.ts, ./webhook.ts) to the hub core
 * (identity, secrets, store), the module registry, Next's `after()` and the
 * database-backed rate limiter. Kept apart from ./index.ts on purpose.
 *
 * Free text is wired to the stub in ./assistant-seam.ts. To connect the shared
 * assistant engine, pass `askAssistant` here (see productionDeps).
 */

import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { consumeLinkCode, lookupIdentity } from "@/lib/integrations/identity";
import { isModuleEnabled, isScopeEnabled } from "@/lib/modules";
import { appBaseUrl } from "@/lib/integrations/store";
import type { ConnectorRow } from "@/lib/integrations/types";
import { defaultAskAssistant } from "./assistant-seam";
import { makeApiCaller } from "./api";
import type { LogLevel, TelegramContext, TelegramDeps } from "./handlers";
import { answerCallbackQuery, editMessageText, sendMessage } from "./http";
import { readTelegramSecrets } from "./secrets";
import { registerChatMenu } from "./setup";
import { createPendingStore, loadTelegramConnectorById } from "./store";
import type { TelegramWebhookDeps } from "./webhook";

function log(level: LogLevel, message: string, meta: Record<string, unknown> = {}): void {
  const line = `[nopm][telegram] ${message}`;
  if (level === "error") console.error(line, meta);
  else if (level === "warn") console.warn(line, meta);
  else console.info(line, meta);
}

function background(work: Promise<unknown>): void {
  try {
    after(() => work);
  } catch {
    // Not inside a request scope (script / test): the work is already running.
  }
}

const RATE_WINDOW_SECONDS = 60;
const USER_RATE_MAX = Number(process.env.NOPM_RATE_TELEGRAM_USER_PER_MIN ?? 30);

/** Same mechanism as src/lib/api/rate-limit.ts. Fail-CLOSED on infrastructure errors: the endpoint is public. */
async function rateCheck(key: string, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { data, error } = await createAdminClient().rpc("nopm_rate_check", { p_key: key, p_max: max, p_window_seconds: RATE_WINDOW_SECONDS });
  if (error) {
    console.error("[nopm][telegram] nopm_rate_check RPC failed - FAILING CLOSED", { error: error.message });
    return { allowed: false, retryAfterSeconds: 30 };
  }
  const r = data as { allowed: boolean; retry_after_seconds: number };
  return { allowed: r.allowed, retryAfterSeconds: r.retry_after_seconds };
}

export function productionDeps(connector: ConnectorRow, origin: string): TelegramDeps {
  const { botToken } = readTelegramSecrets(connector);
  return {
    now: () => new Date(),
    log,
    store: createPendingStore(),
    lookupIdentity,
    consumeLinkCode,
    api: makeApiCaller({ origin: appBaseUrl(origin) || origin }),
    scopeEnabled: (scope) => isScopeEnabled(scope),
    integrationsEnabled: () => isModuleEnabled("integrations"),
    rateAllowed: async (key) => (await rateCheck(key, USER_RATE_MAX)).allowed,
    send: async (chatId, msg) => {
      const res = await sendMessage(botToken, { chatId, text: msg.text, keyboard: msg.keyboard });
      if (!res.ok) log("warn", "telegram reply failed", { connectorId: connector.id, retryable: res.retryable, status: res.status });
      return { messageId: res.ok ? res.result.message_id : null };
    },
    edit: async (chatId, messageId, msg) => {
      const res = await editMessageText(botToken, { chatId, messageId, text: msg.text, keyboard: msg.keyboard });
      if (!res.ok) log("warn", "telegram edit failed", { connectorId: connector.id, status: res.status });
    },
    answer: async (id, text) => {
      await answerCallbackQuery(botToken, id, text);
    },
    setChatMenu: async (chatId, role) => {
      await registerChatMenu(connector, chatId, role);
    },
    askAssistant: defaultAskAssistant,
  };
}

export function productionContext(connector: ConnectorRow, requestOrigin: string): { ctx: TelegramContext; deps: TelegramDeps } {
  return { ctx: { connector, background }, deps: productionDeps(connector, requestOrigin) };
}

export function productionWebhookDeps(): TelegramWebhookDeps {
  return {
    loadConnector: loadTelegramConnectorById,
    readSecrets: readTelegramSecrets,
    rateCheck,
    buildContext: productionContext,
    log,
  };
}

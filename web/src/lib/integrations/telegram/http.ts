/**
 * Telegram Bot API client - plain `fetch`, no SDK (ADR 0020).
 *
 * Six methods the connector needs, plus `getMe` / `deleteWebhook` for setup and
 * disconnect. Every call has a timeout. The bot token is a bearer secret: it
 * travels only in the request URL, and `redact` strips it (and anything shaped
 * like it) from every error string before it leaves this file.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_TIMEOUT_MS = 8000;

/** `<bot id>:<secret>` as BotFather issues it. Deliberately lenient about the secret length. */
const TOKEN_RE = /^\d{3,}:[A-Za-z0-9_-]{6,}$/;
const TOKEN_SHAPE_RE = /\d{3,}:[A-Za-z0-9_-]{6,}/g;

export function isPlausibleBotToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

/** Remove the token (and anything token-shaped) from a string. */
export function redact(text: string, token?: string | null): string {
  let out = text;
  if (token) out = out.split(token).join("[redacted]");
  return out.replace(TOKEN_SHAPE_RE, "[redacted]").replace(/\/bot\[redacted\]/g, "/bot[redacted]");
}

export type TgResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string; status: number; retryable: boolean };

export type InlineButton = { text: string; callback_data?: string; url?: string };
export type InlineKeyboard = InlineButton[][];
export type BotCommand = { command: string; description: string };
export type CommandScope = { type: "default" } | { type: "chat"; chat_id: number | string };

type Opts = { timeoutMs?: number };

export async function callTelegram<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  opts: Opts = {},
): Promise<TgResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TELEGRAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    type Body = { ok?: boolean; result?: T; description?: string; error_code?: number };
    let json = null as Body | null;
    try {
      json = (await res.json()) as Body;
    } catch {
      json = null;
    }
    if (res.ok && json?.ok) return { ok: true, result: json.result as T };
    const status = res.status || json?.error_code || 500;
    const description = json?.description ? String(json.description) : `HTTP ${status}`;
    return { ok: false, error: redact(description, token).slice(0, 300), status, retryable: status === 429 || status >= 500 };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const message = aborted ? "Telegram did not answer in time" : err instanceof Error ? err.message : "network error";
    return { ok: false, error: redact(message, token).slice(0, 300), status: 0, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export type SendOptions = { chatId: number | string; text: string; keyboard?: InlineKeyboard | null };

export function sendMessage(token: string, o: SendOptions, opts?: Opts) {
  return callTelegram<{ message_id: number }>(
    token,
    "sendMessage",
    {
      chat_id: o.chatId,
      text: o.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(o.keyboard ? { reply_markup: { inline_keyboard: o.keyboard } } : {}),
    },
    opts,
  );
}

export function editMessageText(token: string, o: SendOptions & { messageId: number }, opts?: Opts) {
  return callTelegram(
    token,
    "editMessageText",
    {
      chat_id: o.chatId,
      message_id: o.messageId,
      text: o.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: o.keyboard ?? [] },
    },
    opts,
  );
}

export function answerCallbackQuery(token: string, callbackQueryId: string, text?: string, opts?: Opts) {
  return callTelegram(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text: text.slice(0, 200) } : {}) }, opts);
}

/** `secretToken` is 1-256 characters of A-Z a-z 0-9 _ - (Bot API rule). */
export function setWebhook(token: string, url: string, secretToken: string, opts?: Opts) {
  return callTelegram(
    token,
    "setWebhook",
    { url, secret_token: secretToken, allowed_updates: ["message", "callback_query"], drop_pending_updates: false },
    opts,
  );
}

export function deleteWebhook(token: string, opts?: Opts) {
  return callTelegram(token, "deleteWebhook", { drop_pending_updates: true }, opts);
}

export function setMyCommands(token: string, commands: BotCommand[], scope: CommandScope = { type: "default" }, opts?: Opts) {
  return callTelegram(token, "setMyCommands", { commands, scope }, opts);
}

export function deleteMyCommands(token: string, scope: CommandScope = { type: "default" }, opts?: Opts) {
  return callTelegram(token, "deleteMyCommands", { scope }, opts);
}

export function getMe(token: string, opts?: Opts) {
  return callTelegram<{ id: number; username?: string; is_bot: boolean }>(token, "getMe", {}, opts);
}

export type WebhookInfo = { url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string };

export function getWebhookInfo(token: string, opts?: Opts) {
  return callTelegram<WebhookInfo>(token, "getWebhookInfo", {}, opts);
}

/**
 * Telegram cards - wire shapes and small pure helpers (no React, no network).
 * Tolerant readers, like ./model.ts: extra keys are ignored and missing
 * optionals default, so a response can never crash a render. The bot token is
 * write-only: it appears in a request body once and in no view type here.
 */
import { parseExpiry } from "./format";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export type TelegramConnectorView = {
  id: string;
  name: string;
  status: "active" | "paused" | "revoked";
  botUsername: string | null;
};

export type TelegramConnectorState = {
  /** Admins get the full view; a member gets only name and status (id is then empty). */
  connector: TelegramConnectorView | null;
  canManage: boolean;
};

export function normalizeTelegramConnector(raw: unknown): TelegramConnectorState {
  const root = isRec(raw) ? raw : {};
  const c = root.connector;
  const canManage = root.can_manage === true;
  if (!isRec(c)) return { connector: null, canManage };
  const status = c.status === "paused" || c.status === "revoked" ? c.status : "active";
  return {
    connector: { id: str(c.id) ?? "", name: str(c.name) ?? "Telegram", status, botUsername: str(c.bot_username) },
    canManage,
  };
}

export type RegistrationResult = { ok: true } | { ok: false; step: string; error: string };

/** The create call: the new connector plus whether Telegram accepted the webhook and menu. */
export function normalizeTelegramCreated(raw: unknown): { state: TelegramConnectorState; registration: RegistrationResult } {
  const r = isRec(raw) ? raw : {};
  const state = normalizeTelegramConnector({ connector: r, can_manage: true });
  const reg = isRec(r.registration) ? r.registration : {};
  const registration: RegistrationResult =
    reg.ok === true ? { ok: true } : { ok: false, step: str(reg.step) ?? "webhook", error: str(reg.error) ?? "Telegram did not accept the setup." };
  return { state, registration };
}

export type TelegramStatus = {
  webhook: "ok" | "error";
  detail: string | null;
  pendingUpdates: number | null;
  lastUpdateAt: string | null;
};

export function normalizeTelegramStatus(raw: unknown): TelegramStatus {
  const r = isRec(raw) ? raw : {};
  return {
    webhook: r.webhook === "ok" ? "ok" : "error",
    detail: str(r.detail),
    pendingUpdates: typeof r.pending_updates === "number" ? r.pending_updates : null,
    lastUpdateAt: str(r.last_update_at),
  };
}

export type TelegramLinkCode = { code: string; expiresAt: number; deepLink: string | null; botUsername: string | null };

export function normalizeTelegramLinkCode(raw: unknown, nowMs: number): TelegramLinkCode | null {
  if (!isRec(raw)) return null;
  const code = str(raw.code);
  if (!code) return null;
  const link = str(raw.deep_link);
  return {
    code,
    expiresAt: parseExpiry(raw.expires_at, nowMs),
    // Only ever link to Telegram itself.
    deepLink: link && /^https:\/\/t\.me\//.test(link) ? link : null,
    botUsername: str(raw.bot_username),
  };
}

/** The message a member can send by hand when they cannot use the link. */
export const startMessage = (code: string) => `/start ${code.trim()}`;

/** BotFather tokens look like 123456789:AAH... (digits, a colon, then letters/digits/_/-). */
export function validateBotToken(value: string): string | null {
  const v = value.trim();
  if (!v) return "Paste the token BotFather gave you.";
  if (!/^\d{3,}:[A-Za-z0-9_-]{6,}$/.test(v)) return "That does not look like a BotFather token (digits, a colon, then letters and digits).";
  return null;
}

export const WEBHOOK_STEP_LABEL: Record<string, string> = {
  token: "Telegram did not accept the token",
  webhook: "Telegram did not accept the webhook",
  menu: "The command menu could not be set",
};

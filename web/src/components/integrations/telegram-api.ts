/**
 * Telegram cards - every network call, in one place. Same-origin through
 * `@/lib/api-client`.
 *
 *   GET    /api/integrations/telegram/connector               -> { connector | null, can_manage }
 *   POST   /api/integrations/telegram/connector               -> connect (setWebhook + setMyCommands)
 *   PATCH  /api/integrations/telegram/connector               -> { status: active | paused }
 *   DELETE /api/integrations/telegram/connector               -> disconnect
 *   POST   /api/integrations/telegram/{id}/setup              -> re-register webhook and menu
 *   GET    /api/integrations/telegram/{id}/status             -> webhook health
 *   POST   /api/integrations/telegram/{id}/test               -> test message to my own chat
 *   POST   /api/integrations/telegram/link-code               -> one-time code and t.me link
 *   (unlink reuses DELETE /api/integrations/identities/{id})
 */
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api-client";
import {
  normalizeTelegramConnector,
  normalizeTelegramCreated,
  normalizeTelegramLinkCode,
  normalizeTelegramStatus,
} from "./telegram-model";

const BASE = "/api/integrations/telegram";
const enc = encodeURIComponent;

export async function fetchTelegramConnector() {
  return normalizeTelegramConnector(await apiGet<unknown>(`${BASE}/connector`));
}

export async function connectTelegram(token: string) {
  return normalizeTelegramCreated(await apiPost<unknown>(`${BASE}/connector`, { token: token.trim() }));
}

export async function setTelegramStatus(status: "active" | "paused"): Promise<void> {
  await apiPatch(`${BASE}/connector`, { status });
}

export async function disconnectTelegram(): Promise<void> {
  await apiDelete(`${BASE}/connector`);
}

export async function registerTelegram(id: string): Promise<{ ok: boolean; error: string | null }> {
  const r = await apiPost<{ ok?: boolean; error?: string }>(`${BASE}/${enc(id)}/setup`);
  return { ok: r?.ok === true, error: typeof r?.error === "string" ? r.error : null };
}

export async function fetchTelegramStatus(id: string) {
  return normalizeTelegramStatus(await apiGet<unknown>(`${BASE}/${enc(id)}/status`));
}

export async function sendTelegramTest(id: string): Promise<{ ok: boolean; error: string | null }> {
  const r = await apiPost<{ ok?: boolean; error?: string }>(`${BASE}/${enc(id)}/test`);
  return { ok: r?.ok === true, error: typeof r?.error === "string" ? r.error : null };
}

export async function mintTelegramLinkCode(nowMs: number) {
  const code = normalizeTelegramLinkCode(await apiPost<unknown>(`${BASE}/link-code`), nowMs);
  if (!code) throw new Error("The server did not return a link code. Try again.");
  return code;
}

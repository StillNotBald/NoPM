/**
 * Persistence for the Telegram connector: the connector row (kind `telegram`)
 * and the durable chat state (`chat_pending`, migration 0120).
 *
 * Every query filters `workspace_id` or the connector id (service-role client,
 * RLS bypassed). The raw row carries `secret_enc` and never leaves the server;
 * `toPublicTelegramConnector` exposes presence booleans and the webhook URL only.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { CONNECTOR_COLUMNS, normalizeConfig } from "@/lib/integrations/store";
import type { ConnectorRow } from "@/lib/integrations/types";
import type { PendingKind, PendingRow, PendingStatus, PendingStore } from "./handlers";
import { encryptTelegramSecrets, webhookUrl } from "./secrets";

function hydrate(row: Record<string, unknown>): ConnectorRow {
  return { ...(row as unknown as ConnectorRow), config: normalizeConfig(row.config) };
}

/** By id alone (the webhook URL carries nothing else). Any status. */
export async function loadTelegramConnectorById(connectorId: string): Promise<ConnectorRow | null> {
  const { data, error } = await createAdminClient()
    .from("integration_connectors")
    .select(CONNECTOR_COLUMNS)
    .eq("id", connectorId)
    .eq("kind", "telegram")
    .maybeSingle();
  if (error) throw error;
  return data ? hydrate(data as Record<string, unknown>) : null;
}

export async function getTelegramConnector(workspaceId: string, id: string): Promise<ConnectorRow | null> {
  const { data, error } = await createAdminClient()
    .from("integration_connectors")
    .select(CONNECTOR_COLUMNS)
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .eq("kind", "telegram")
    .maybeSingle();
  if (error) throw error;
  return data ? hydrate(data as Record<string, unknown>) : null;
}

/** The workspace's live (active or paused) Telegram connector; at most one. */
export async function getLiveTelegramConnector(workspaceId: string): Promise<ConnectorRow | null> {
  const { data, error } = await createAdminClient()
    .from("integration_connectors")
    .select(CONNECTOR_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("kind", "telegram")
    .in("status", ["active", "paused"])
    .maybeSingle();
  if (error) throw error;
  return data ? hydrate(data as Record<string, unknown>) : null;
}

export type PublicTelegramConnector = {
  id: string;
  kind: "telegram";
  name: string;
  status: ConnectorRow["status"];
  /** The bot's public @name (not a secret). */
  bot_username: string;
  webhook_url: string;
  has_bot_token: boolean;
  created_at: string;
  updated_at: string;
};

export function toPublicTelegramConnector(row: ConnectorRow, base: string): PublicTelegramConnector {
  return {
    id: row.id,
    kind: "telegram",
    name: row.name,
    status: row.status,
    bot_username: normalizeConfig(row.config).appId,
    webhook_url: webhookUrl(base, row.id),
    has_bot_token: !!row.secret_enc && row.status !== "revoked",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * After the audited revoke: drop the chat's working state and erase the bot token. Returns whether the
 * token was erased. The connector is already revoked, so a failure here leaves a dead credential at worst.
 */
export async function disconnectCleanup(workspaceId: string, connectorId: string): Promise<boolean> {
  const db = createAdminClient();
  await db.from("chat_pending").delete().eq("connector_id", connectorId).eq("workspace_id", workspaceId);
  try {
    const blank = encryptTelegramSecrets({ botToken: "", webhookSecret: "" });
    const { error } = await db.from("integration_connectors").update({ secret_enc: blank }).eq("id", connectorId).eq("workspace_id", workspaceId);
    return !error;
  } catch {
    return false;
  }
}

/** When the bot last received an update (the newest de-dupe marker). Null if it never has. */
export async function lastTelegramUpdateAt(connectorId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("chat_pending")
    .select("created_at")
    .eq("connector_id", connectorId)
    .eq("kind", "seen")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length ? String((data[0] as { created_at: string }).created_at) : null;
}

/** The private chat id of the member's active link on this connector (a private chat id equals the Telegram user id). */
export async function findLinkedChatId(workspaceId: string, connectorId: string, profileId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("external_identities")
    .select("external_user_id")
    .eq("workspace_id", workspaceId)
    .eq("connector_id", connectorId)
    .eq("profile_id", profileId)
    .is("revoked_at", null)
    .limit(1);
  if (error) throw error;
  return data && data.length ? String((data[0] as { external_user_id: string }).external_user_id) : null;
}

// ── chat_pending ───────────────────────────────────────────────────────────

const COLUMNS = "id, workspace_id, connector_id, chat_id, kind, payload, version, status, profile_id, expires_at";
const SEEN_TTL_MS = 2 * 24 * 60 * 60 * 1000;

function asRow(data: unknown): PendingRow {
  return data as PendingRow;
}

export function createPendingStore(): PendingStore {
  const db = () => createAdminClient();
  return {
    async dedupe(connector, chatId, key) {
      const { error } = await db()
        .from("chat_pending")
        .insert({
          workspace_id: connector.workspace_id,
          connector_id: connector.id,
          chat_id: chatId,
          kind: "seen",
          dedupe_key: key,
          status: "done",
          expires_at: new Date(Date.now() + SEEN_TTL_MS).toISOString(),
        });
      if (!error) return true;
      if (error.code === "23505") return false; // already seen
      throw error; // fail closed: an update we cannot de-duplicate is not processed
    },

    async create(connector, chatId, profileId, kind: PendingKind, payload, ttlMs) {
      const { data, error } = await db()
        .from("chat_pending")
        .insert({
          workspace_id: connector.workspace_id,
          connector_id: connector.id,
          chat_id: chatId,
          kind,
          payload,
          profile_id: profileId,
          expires_at: new Date(Date.now() + ttlMs).toISOString(),
        })
        .select(COLUMNS)
        .single();
      if (error) throw error;
      return asRow(data);
    },

    async get(connectorId, id) {
      const { data, error } = await db().from("chat_pending").select(COLUMNS).eq("id", id).eq("connector_id", connectorId).maybeSingle();
      if (error) throw error;
      return data ? asRow(data) : null;
    },

    async latestOpen(connectorId, chatId, profileId) {
      const { data, error } = await db()
        .from("chat_pending")
        .select(COLUMNS)
        .eq("connector_id", connectorId)
        .eq("chat_id", chatId)
        .eq("profile_id", profileId)
        .eq("status", "open")
        .in("kind", ["ask", "preview", "pick"])
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return data && data.length ? asRow(data[0]) : null;
    },

    async advance(row, patch) {
      const update: Record<string, unknown> = { version: row.version + 1, status: (patch.status ?? "open") as PendingStatus };
      if (patch.kind) update.kind = patch.kind;
      if (patch.payload) update.payload = patch.payload;
      if (patch.ttlMs) update.expires_at = new Date(Date.now() + patch.ttlMs).toISOString();
      // Compare-and-swap: only the caller that still sees (version, open) wins.
      const { data, error } = await db()
        .from("chat_pending")
        .update(update)
        .eq("id", row.id)
        .eq("connector_id", row.connector_id)
        .eq("version", row.version)
        .eq("status", "open")
        .select(COLUMNS);
      if (error) throw error;
      return data && data.length ? asRow(data[0]) : null;
    },

    async settle(id, status) {
      const { error } = await db().from("chat_pending").update({ status }).eq("id", id);
      if (error) throw error;
    },

    async cancelOpen(connectorId, chatId, profileId) {
      let q = db()
        .from("chat_pending")
        .update({ status: "cancelled" })
        .eq("connector_id", connectorId)
        .eq("chat_id", chatId)
        .eq("status", "open")
        .in("kind", ["ask", "preview", "pick"]);
      if (profileId) q = q.eq("profile_id", profileId);
      const { error } = await q;
      if (error) throw error;
    },
  };
}

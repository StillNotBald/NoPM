import { route } from "@/lib/api/handler";
import { ApiError, NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { created, ok, safeJson, validationError } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedInsert, auditedUpdate } from "@/lib/audit/audited-write";
import { appBaseUrl, assertIntegrationAdmin, isIntegrationAdmin } from "@/lib/integrations/store";
import { isPlausibleBotToken, redact } from "@/lib/integrations/telegram/http";
import { encryptTelegramSecrets, generateWebhookSecret } from "@/lib/integrations/telegram/secrets";
import { registerTelegram, removeWebhook, testTelegram } from "@/lib/integrations/telegram/setup";
import { disconnectCleanup, getLiveTelegramConnector, toPublicTelegramConnector } from "@/lib/integrations/telegram/store";
import type { ConnectorRow } from "@/lib/integrations/types";

export const runtime = "nodejs";

const NAME_MAX = 100;
const origin = (request: Request) => appBaseUrl(new URL(request.url).origin);

/**
 * Telegram connector (ADR 0020, R-190). One live connector per workspace; admin
 * sessions only (never a token). The bot token is encrypted at rest and is never
 * returned by any response; the per-connector webhook secret is generated here
 * and never leaves the server.
 *
 *   GET    -> { connector | null, can_manage }   (members see only name and status)
 *   POST   -> { token, name? } checks the token with Telegram, stores it, registers
 *             the webhook and menu          -> connector + registration result
 *   PATCH  -> { status: active|paused }       turn the bot off or on (pending rows are kept)
 *   DELETE -> disconnect: webhook deleted, token erased, pending rows dropped, chats unlinked
 */
export const GET = route(async ({ actor, request }) => {
  if (actor.type !== "user") throw new ScopeError("Integrations are available to signed-in users");
  const row = await getLiveTelegramConnector(actor.workspaceId);
  const admin = isIntegrationAdmin(actor);
  return ok({
    connector: row ? (admin ? toPublicTelegramConnector(row, origin(request)) : { name: row.name, status: row.status }) : null,
    can_manage: admin,
  });
});

export const POST = route(async ({ actor, request }) => {
  assertIntegrationAdmin(actor);
  const body = (await safeJson(request)) as { token?: unknown; name?: unknown } | null;
  const token = body && typeof body === "object" ? body.token : undefined;
  if (!isPlausibleBotToken(token)) {
    return validationError("Validation failed", [{ field: "token", message: "Paste the token BotFather gave you (digits, a colon, then letters and digits)" }]);
  }
  const rawName = body && typeof body === "object" && "name" in body ? body.name : undefined;
  if (rawName !== undefined && (typeof rawName !== "string" || rawName.trim().length < 1 || rawName.trim().length > NAME_MAX)) {
    return validationError("Validation failed", [{ field: "name", message: `name must be 1 to ${NAME_MAX} characters` }]);
  }
  if (await getLiveTelegramConnector(actor.workspaceId)) {
    throw new RuleError("This workspace already has a Telegram connector. Disconnect it before connecting another.", "connector_exists");
  }

  // Nothing is stored unless Telegram accepts the token.
  const me = await testTelegram(token);
  if (!me.ok) throw new RuleError("Telegram did not accept this token", "token_rejected");

  let secretEnc: string;
  try {
    secretEnc = encryptTelegramSecrets({ botToken: token, webhookSecret: generateWebhookSecret() });
  } catch {
    throw new ApiError(503, "Server encryption key (NOPM_ENCRYPTION_KEY) is not configured", "encryption_unavailable");
  }

  let row: ConnectorRow;
  try {
    const { after } = await auditedInsert({
      table: "integration_connectors",
      actor,
      patch: {
        kind: "telegram",
        name: typeof rawName === "string" ? rawName.trim() : "Telegram",
        status: "active",
        config: { appId: me.username ?? "", mode: "webhook" },
        secret_enc: secretEnc,
        created_by: actor.id,
      },
      action: "integration.connector.create",
      targetType: "integration_connector",
      auditAfter: { kind: "telegram", name: typeof rawName === "string" ? rawName.trim() : "Telegram", status: "active" },
      auditBefore: null,
      omitColumns: ["secret_enc"],
    });
    row = { ...(after as unknown as ConnectorRow), secret_enc: secretEnc };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "23505") {
      throw new RuleError("This workspace already has a Telegram connector.", "connector_exists");
    }
    throw err;
  }

  const registration = await registerTelegram(row, origin(request));
  return created({
    ...toPublicTelegramConnector(row, origin(request)),
    registration: registration.ok ? { ok: true } : { ok: false, step: registration.step, error: redact(registration.error, token).slice(0, 300) },
  });
});

export const PATCH = route(async ({ actor, request }) => {
  assertIntegrationAdmin(actor);
  const body = (await safeJson(request)) as { status?: unknown } | null;
  if (!body || (body.status !== "active" && body.status !== "paused")) {
    return validationError("Validation failed", [{ field: "status", message: "status must be 'active' or 'paused'" }]);
  }
  const existing = await getLiveTelegramConnector(actor.workspaceId);
  if (!existing) throw new NotFoundError("No Telegram connector to update");
  const { after } = await auditedUpdate({
    table: "integration_connectors",
    actor,
    id: existing.id,
    patch: { status: body.status },
    action: "integration.connector.update",
    targetType: "integration_connector",
    auditBefore: { kind: "telegram", status: existing.status },
    auditAfter: { kind: "telegram", status: body.status },
    omitColumns: ["secret_enc", "relay_secret_hash"],
  });
  return ok(toPublicTelegramConnector({ ...existing, ...(after as unknown as Partial<ConnectorRow>) }, origin(request)));
});

export const DELETE = route(async ({ actor, request }) => {
  assertIntegrationAdmin(actor);
  const existing = await getLiveTelegramConnector(actor.workspaceId);
  if (!existing) throw new NotFoundError("No Telegram connector to disconnect");

  const db = createAdminClient();
  const nowIso = new Date().toISOString();
  // One transaction (migration 0069): connector revoked, every identity unlinked, queued deliveries
  // superseded, unused link codes dropped, ONE audit row.
  const { error } = await db.rpc("nopm_revoke_connector", {
    p_workspace_id: actor.workspaceId,
    p_connector_id: existing.id,
    p_actor_type: actor.type,
    p_actor_id: actor.id,
    p_actor_label: actor.label,
    p_before: { kind: "telegram", name: existing.name, status: existing.status },
    p_after: { kind: "telegram", name: existing.name, status: "revoked" },
    p_revoked_at: nowIso,
    p_channel: actor.channel ?? null,
    p_correlation_id: actor.requestId ?? null,
  });
  if (error) {
    if (/CONNECTOR_REVOKED/.test(error.message)) throw new RuleError("This connector is already revoked", "connector_revoked");
    if (/CONNECTOR_NOT_FOUND/.test(error.message)) throw new NotFoundError("Connector not found");
    throw error;
  }

  // Only after the audited revoke committed: stop Telegram calling us (best effort). If the audit write
  // failed we threw above, and nothing was undone.
  await removeWebhook(existing);

  // Chat state and the token go with the connector (working state and the secret itself, not separate governed changes).
  const erased = await disconnectCleanup(actor.workspaceId, existing.id);
  return ok({ ...toPublicTelegramConnector({ ...existing, status: "revoked", secret_enc: "" }, origin(request)), token_erased: erased });
});


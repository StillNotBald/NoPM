import { route } from "@/lib/api/handler";
import { ApiError, RuleError, ScopeError } from "@/lib/api/errors";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { getConnectorHealth } from "@/lib/integrations/health";
import { encryptSecrets, generateRelaySecret } from "@/lib/integrations/secrets";
import {
  CONNECTOR_COLUMNS,
  appBaseUrl,
  assertIntegrationAdmin,
  callbackUrls,
  isIntegrationAdmin,
  listConnectors,
  normalizeConfig,
  toAuditConnector,
  toPublicConnector,
  toRedactedConnector,
} from "@/lib/integrations/store";
import type { ConnectorRow, LarkConfig } from "@/lib/integrations/types";
import { createConnectorSchema } from "./_schema";

export const runtime = "nodejs";

/**
 * GET /api/integrations/connectors — the workspace's connectors, in one of two
 * shapes by role (signed-in sessions only):
 *  - admin: the full public view (presence flags + non-secret config, the
 *    revoked history, the `callback_urls` for the Lark console setup, and a
 *    `health` block: queue counts, dead letters, last send, last failure text
 *    and the last scheduler run; null for a revoked connector or when the
 *    lookup failed, so "unknown" never reads as "0 dead") — never ciphertext,
 *    the relay hash or any secret value;
 *  - any other member, viewers included: a REDACTED view of the live
 *    (non-revoked) connectors — id, name, kind, status, region, mode,
 *    approvals.enabled, digest.enabled — so the page can say "Lark is connected;
 *    approvals on" without exposing the app id, chat id, secrets or URLs.
 * Every mutation stays admin-only.
 */
export const GET = route(async ({ actor, request }) => {
  if (actor.type !== "user") throw new ScopeError("Integrations are available to signed-in users");

  const rows = await listConnectors(actor.workspaceId);
  const items = isIntegrationAdmin(actor)
    ? await Promise.all(
        rows.map(async (row) => ({
          ...toPublicConnector(row),
          callback_urls: callbackUrls(appBaseUrl(new URL(request.url).origin), row.id),
          health: row.status === "revoked" ? null : await getConnectorHealth(actor.workspaceId, row.id),
        })),
      )
    : rows.filter((row) => row.status !== "revoked").map(toRedactedConnector);
  return okList(items, { total: items.length, page: 1, limit: Math.max(items.length, 1) });
});

/**
 * POST /api/integrations/connectors — connect a Lark / Feishu app (admin only).
 * One live connector per kind per workspace (partial unique index). The app
 * credentials are encrypted at rest; the RELAY secret for the self-host worker
 * is generated here, stored only as a hash and returned exactly once.
 */
export const POST = route(async ({ actor, request }) => {
  assertIntegrationAdmin(actor);

  const parsed = createConnectorSchema.safeParse(await safeJson(request));
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }
  const input = parsed.data;

  const db = createAdminClient();
  const { data: existing, error: existingError } = await db
    .from("integration_connectors")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .eq("kind", input.kind)
    .neq("status", "revoked")
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    throw new RuleError(
      "This workspace already has a Lark connector. Edit or revoke it before connecting another.",
      "connector_exists",
    );
  }

  let secretEnc: string;
  try {
    secretEnc = encryptSecrets({
      appSecret: input.app_secret,
      verificationToken: input.verification_token,
      encryptKey: input.encrypt_key ?? null,
    });
  } catch {
    throw new ApiError(503, "Server encryption key (NOPM_ENCRYPTION_KEY) is not configured", "encryption_unavailable");
  }

  const config: LarkConfig = {
    region: input.region,
    appId: input.app_id,
    mode: input.mode,
    approvals: { enabled: input.approvals.enabled },
    digest: {
      enabled: input.digest.enabled,
      chatId: input.digest.chat_id ?? null,
      weekday: input.digest.weekday,
    },
  };
  const relay = generateRelaySecret();

  const { data: row, error } = await db
    .from("integration_connectors")
    .insert({
      workspace_id: actor.workspaceId, // always from the actor — never the body
      kind: input.kind,
      name: input.name,
      status: "active",
      config,
      secret_enc: secretEnc,
      relay_secret_hash: relay.hash,
      created_by: actor.id,
    })
    .select(CONNECTOR_COLUMNS)
    .single();
  if (error?.code === "23505") {
    throw new RuleError("This workspace already has a Lark connector.", "connector_exists");
  }
  if (error || !row) throw error ?? new Error("Failed to create connector");

  const connector: ConnectorRow = { ...(row as unknown as ConnectorRow), config: normalizeConfig(row.config) };
  const view = toPublicConnector(connector);

  // The audit row carries the public view only — never a secret or a hash — with
  // the app id and group chat id masked (the audit stream is member-readable).
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "integration.connector.create",
    targetType: "integration_connector",
    targetId: connector.id,
    before: null,
    after: toAuditConnector(view),
  });

  const base = appBaseUrl(new URL(request.url).origin);
  return created({
    ...view,
    // Shown ONCE. Only the self-host relay worker needs it (mode long_connection).
    relay_secret: relay.raw,
    callback_urls: callbackUrls(base, connector.id),
  });
});

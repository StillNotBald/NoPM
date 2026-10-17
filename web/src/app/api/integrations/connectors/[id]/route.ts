import { route } from "@/lib/api/handler";
import { ApiError, NotFoundError, RuleError } from "@/lib/api/errors";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { decryptSecrets, encryptSecrets, generateRelaySecret } from "@/lib/integrations/secrets";
import {
  CONNECTOR_COLUMNS,
  assertIntegrationAdmin,
  getConnector,
  normalizeConfig,
  toAuditConnector,
  toPublicConnector,
} from "@/lib/integrations/store";
import type { ConnectorRow, LarkConfig, LarkSecrets } from "@/lib/integrations/types";
import { ENCRYPT_KEY_REQUIRED_MESSAGE, updateConnectorSchema } from "../_schema";

export const runtime = "nodejs";

/**
 * PATCH /api/integrations/connectors/[id] — rename, pause/resume (the kill
 * switch: paused stops BOTH directions), change non-secret config, replace
 * credentials, or rotate the relay secret (admin only). Credentials are
 * write-only: an update never returns them, and the audit row records WHICH
 * secrets changed, not their values.
 */
export const PATCH = route(async ({ actor, params, request }) => {
  assertIntegrationAdmin(actor);

  const connector = await getConnector(actor.workspaceId, params.id);
  if (!connector) throw new NotFoundError("Connector not found");
  if (connector.status === "revoked") throw new RuleError("This connector is revoked", "connector_revoked");

  const parsed = updateConnectorSchema.safeParse(await safeJson(request));
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }
  const input = parsed.data;
  const before = toAuditConnector(toPublicConnector(connector));

  // Non-secret config: shallow-merge over what is stored.
  const current = normalizeConfig(connector.config);
  // The app id is the connector's identity on the platform: linked accounts are
  // app-scoped ids and sent cards can only be edited by the app that sent them.
  // Swapping it would strand both, so a different app is a new connector.
  if (input.app_id !== undefined && input.app_id !== current.appId) {
    throw new RuleError(
      "The app id of a connector cannot be changed: the accounts linked to it and the cards it already sent belong to that app. Revoke this connector and create a new connector for the new app.",
      "app_id_immutable",
    );
  }
  const nextConfig: LarkConfig = {
    region: input.region ?? current.region,
    appId: input.app_id ?? current.appId,
    mode: input.mode ?? current.mode,
    approvals: { enabled: input.approvals?.enabled ?? current.approvals.enabled },
    digest: {
      enabled: input.digest?.enabled ?? current.digest.enabled,
      chatId: input.digest && "chat_id" in input.digest ? (input.digest.chat_id ?? null) : current.digest.chatId,
      weekday: input.digest?.weekday ?? current.digest.weekday,
    },
  };
  if (nextConfig.digest.enabled && !nextConfig.digest.chatId) {
    return validationError("Validation failed", [
      { field: "digest.chat_id", message: "digest.chat_id is required when the digest is enabled" },
    ]);
  }

  const patch: Record<string, unknown> = { config: nextConfig };
  if (input.name !== undefined) patch.name = input.name;
  if (input.status !== undefined) patch.status = input.status;

  // Secrets: merge into the decrypted blob and re-encrypt.
  const secretFields = [
    input.app_secret !== undefined && "app_secret",
    input.verification_token !== undefined && "verification_token",
    input.encrypt_key !== undefined && "encrypt_key",
  ].filter(Boolean) as string[];
  // The Encrypt Key the connector will hold after this update (undefined = not
  // known yet; read from the stored blob only if the rule below needs it).
  let encryptKeyAfter: string | null | undefined;
  if (secretFields.length > 0) {
    let currentSecrets: LarkSecrets | null = null;
    try {
      currentSecrets = decryptSecrets(connector.secret_enc);
    } catch {
      currentSecrets = null;
    }
    const nextSecrets: LarkSecrets | null =
      currentSecrets ??
      (input.app_secret !== undefined && input.verification_token !== undefined
        ? { appSecret: input.app_secret, verificationToken: input.verification_token, encryptKey: null }
        : null);
    if (!nextSecrets) {
      throw new RuleError(
        "Stored credentials cannot be read; send both app_secret and verification_token to replace them",
        "secrets_unreadable",
      );
    }
    if (input.app_secret !== undefined) nextSecrets.appSecret = input.app_secret;
    if (input.verification_token !== undefined) nextSecrets.verificationToken = input.verification_token;
    if (input.encrypt_key !== undefined) nextSecrets.encryptKey = input.encrypt_key;
    encryptKeyAfter = nextSecrets.encryptKey ?? null;
    try {
      patch.secret_enc = encryptSecrets(nextSecrets);
    } catch {
      throw new ApiError(503, "Server encryption key (NOPM_ENCRYPTION_KEY) is not configured", "encryption_unavailable");
    }
  }

  // Webhook mode needs an Encrypt Key (see ENCRYPT_KEY_REQUIRED_MESSAGE). Checked
  // on the state the update would leave behind, whenever it touches the mode or
  // the credentials; a pause, a rename or a digest tweak on an older keyless
  // connector is not held up by it.
  if ((input.mode !== undefined || secretFields.length > 0) && nextConfig.mode === "webhook") {
    if (encryptKeyAfter === undefined) {
      try {
        encryptKeyAfter = decryptSecrets(connector.secret_enc).encryptKey ?? null;
      } catch {
        encryptKeyAfter = null;
      }
    }
    if (!encryptKeyAfter) {
      return validationError("Validation failed", [{ field: "encrypt_key", message: ENCRYPT_KEY_REQUIRED_MESSAGE }]);
    }
  }

  const clearingPin = input.clear_tenant_pin === true;
  if (clearingPin) patch.tenant_key = null;

  let rotatedRelaySecret: string | null = null;
  if (input.rotate_relay_secret) {
    const relay = generateRelaySecret();
    patch.relay_secret_hash = relay.hash;
    rotatedRelaySecret = relay.raw;
  }

  const db = createAdminClient();
  const { data: row, error } = await db
    .from("integration_connectors")
    .update(patch)
    .eq("id", connector.id)
    .eq("workspace_id", actor.workspaceId)
    .neq("status", "revoked")
    .select(CONNECTOR_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new RuleError("This connector is revoked", "connector_revoked");

  const updated: ConnectorRow = { ...(row as unknown as ConnectorRow), config: normalizeConfig(row.config) };
  const after = toPublicConnector(updated);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "integration.connector.update",
    targetType: "integration_connector",
    targetId: updated.id,
    before,
    after: {
      ...toAuditConnector(after),
      // Which secrets were replaced — never their values.
      secrets_changed: secretFields,
      relay_secret_rotated: rotatedRelaySecret !== null,
      tenant_pin_cleared: clearingPin && !!connector.tenant_key,
    },
  });

  return ok({ ...after, ...(rotatedRelaySecret ? { relay_secret: rotatedRelaySecret } : {}) });
});

/**
 * DELETE /api/integrations/connectors/[id] — revoke (admin only). Irreversible:
 * the connector stops in both directions, every linked identity is unlinked,
 * queued deliveries are superseded and unused link codes are dropped. Rows are
 * kept (status 'revoked') so the history stays auditable.
 */
export const DELETE = route(async ({ actor, params }) => {
  assertIntegrationAdmin(actor);

  const connector = await getConnector(actor.workspaceId, params.id);
  if (!connector) throw new NotFoundError("Connector not found");
  if (connector.status === "revoked") throw new RuleError("This connector is already revoked", "connector_revoked");

  const db = createAdminClient();
  const nowIso = new Date().toISOString();

  // The connector first: this alone stops inbound and outbound.
  const { data: row, error } = await db
    .from("integration_connectors")
    .update({ status: "revoked", revoked_at: nowIso })
    .eq("id", connector.id)
    .eq("workspace_id", actor.workspaceId)
    .neq("status", "revoked")
    .select(CONNECTOR_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new RuleError("This connector is already revoked", "connector_revoked");

  const { data: identities, error: identityError } = await db
    .from("external_identities")
    .update({ revoked_at: nowIso })
    .eq("workspace_id", actor.workspaceId)
    .eq("connector_id", connector.id)
    .is("revoked_at", null)
    .select("id");
  if (identityError) throw identityError;

  const { data: deliveries, error: deliveryError } = await db
    .from("integration_deliveries")
    .update({ status: "superseded", last_error: "connector revoked", locked_until: null })
    .eq("workspace_id", actor.workspaceId)
    .eq("connector_id", connector.id)
    .in("status", ["pending", "retry"])
    .select("id");
  if (deliveryError) throw deliveryError;

  const { error: codeError } = await db
    .from("identity_link_codes")
    .delete()
    .eq("workspace_id", actor.workspaceId)
    .eq("connector_id", connector.id)
    .is("used_at", null);
  if (codeError) throw codeError;

  const revoked: ConnectorRow = { ...(row as unknown as ConnectorRow), config: normalizeConfig(row.config) };
  const view = toPublicConnector(revoked);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "integration.connector.revoke",
    targetType: "integration_connector",
    targetId: revoked.id,
    before: toAuditConnector(toPublicConnector(connector)),
    after: {
      ...toAuditConnector(view),
      identities_revoked: (identities ?? []).length,
      deliveries_superseded: (deliveries ?? []).length,
    },
  });

  return ok(view);
});

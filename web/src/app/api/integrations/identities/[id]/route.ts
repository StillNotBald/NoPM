import { route } from "@/lib/api/handler";
import { NotFoundError, ScopeError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { maskedExternalRef } from "@/lib/integrations/identity";
import { isIntegrationAdmin } from "@/lib/integrations/store";

export const runtime = "nodejs";

/**
 * DELETE /api/integrations/identities/[id] — unlink a platform account. The
 * owner may unlink their own; a workspace admin may unlink anyone's (e.g. a
 * leaver). Soft: the row keeps its history with `revoked_at` set, and any card
 * the person still holds stops working immediately (no active identity = the
 * click resolves to "unlinked").
 */
export const DELETE = route(async ({ actor, params }) => {
  if (actor.type !== "user") throw new ScopeError("Unlinking requires a signed-in session");

  const db = createAdminClient();
  const { data: identity, error } = await db
    .from("external_identities")
    .select("id, connector_id, provider, profile_id, external_tenant, external_user_id")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!identity) throw new NotFoundError("Linked account not found");

  if (identity.profile_id !== actor.id && !isIntegrationAdmin(actor)) {
    throw new ScopeError("You can only unlink your own account");
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: updateError } = await db
    .from("external_identities")
    .update({ revoked_at: nowIso })
    .eq("id", identity.id)
    .eq("workspace_id", actor.workspaceId)
    .is("revoked_at", null)
    .select("id");
  if (updateError) throw updateError;
  if (!updated || updated.length === 0) throw new NotFoundError("Linked account not found");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "integration.identity.unlink",
    targetType: "external_identity",
    targetId: identity.id,
    before: {
      connector_id: identity.connector_id,
      profile_id: identity.profile_id,
      external_ref: maskedExternalRef(identity.provider, identity.external_tenant, identity.external_user_id),
    },
    after: { revoked: true, unlinked_by_owner: identity.profile_id === actor.id },
  });

  return ok({ id: identity.id, revoked: true });
});

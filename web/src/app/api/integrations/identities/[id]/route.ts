import { route } from "@/lib/api/handler";
import { NotFoundError, PreconditionFailedError, ScopeError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate } from "@/lib/audit/audited-write";
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

  // The unlink and its audit row are one transaction (nopm_mutate_audited, migration 0103). The audit
  // payload carries the masked platform reference, never the raw external ids.
  try {
    await auditedUpdate({
      table: "external_identities",
      actor,
      action: "integration.identity.unlink",
      id: identity.id,
      patch: { revoked_at: new Date().toISOString() },
      notFoundMessage: "Linked account not found",
      // Compare-and-set: losing a race with a concurrent unlink is a 412, never a second audit row.
      requireNull: "revoked_at",
      auditBefore: {
        connector_id: identity.connector_id,
        profile_id: identity.profile_id,
        external_ref: maskedExternalRef(identity.provider, identity.external_tenant, identity.external_user_id),
      },
      auditAfter: { revoked: true, unlinked_by_owner: identity.profile_id === actor.id },
  });
  } catch (e) {
    if (e instanceof PreconditionFailedError) throw new NotFoundError("Linked account not found");
    throw e;
  }

  return ok({ id: identity.id, revoked: true });
});

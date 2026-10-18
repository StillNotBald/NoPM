import { route } from "@/lib/api/handler";
import { ScopeError, NotFoundError, ConflictError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate } from "@/lib/audit/audited-write";
import { ok } from "@/lib/api/response";
import type { Actor } from "@/lib/auth/guard";
import { assertCanRevokeCreatedBy } from "@/lib/governance/invite-guard";

export const runtime = "nodejs";

/** Guard: only admin/manager user sessions may manage API tokens. */
function requireTokenAdmin(actor: Actor): void {
  if (
    actor.type !== "user" ||
    !["admin", "manager"].includes(actor.role ?? "")
  ) {
    throw new ScopeError("Token management requires an admin/manager session");
  }
}

// DELETE /api/tokens/[id] — revoke a PERSONAL token (set revoked = true).
// Only kind = 'user' tokens are addressable here: the assistant's per-turn
// ephemeral tokens (kind = 'assistant') are not in the inventory, so they are 404.
// Revoking an already revoked token is 409 and writes no second audit row.
export const DELETE = route(async ({ actor, params }) => {
  requireTokenAdmin(actor);

  const db = createAdminClient();

  // Fetch the existing row for workspace guard + before snapshot
  const { data: before, error: fetchError } = await db
    .from("api_tokens")
    .select("id, name, prefix, scopes, expires_at, revoked, last_used_at, created_at, created_by")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("kind", "user")
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("API token not found");
  if (before.revoked) throw new ConflictError("Token already revoked", "already_revoked");

  // Q-ACC-9: a manager cannot revoke a token an admin created.
  if (before.created_by && actor.role !== "admin") {
    const { data: creator, error: creatorError } = await db
      .from("profiles")
      .select("role")
      .eq("id", before.created_by)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (creatorError) throw creatorError;
    assertCanRevokeCreatedBy(actor.role, creator?.role);
  }

  // The update and its audit row are one transaction (nopm_mutate_audited, migration 0103).
  await auditedUpdate({
    table: "api_tokens",
    actor,
    action: "token.revoke",
    id: params.id,
    patch: { revoked: true },
    notFoundMessage: "API token not found",
    auditBefore: before,
    auditAfter: { ...before, revoked: true },
  });

  return ok({ revoked: true });
});

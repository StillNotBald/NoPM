import { route } from "@/lib/api/handler";
import { ScopeError, NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import type { Actor } from "@/lib/auth/guard";

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

// DELETE /api/tokens/[id] — revoke a token (set revoked = true)
export const DELETE = route(async ({ actor, params }) => {
  requireTokenAdmin(actor);

  const db = createAdminClient();

  // Fetch the existing row for workspace guard + before snapshot
  const { data: before, error: fetchError } = await db
    .from("api_tokens")
    .select("id, name, prefix, scopes, expires_at, revoked, last_used_at, created_at")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("API token not found");

  const { error: updateError } = await db
    .from("api_tokens")
    .update({ revoked: true })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "token.revoke",
    targetType: "api_token",
    targetId: params.id,
    before,
    after: { ...before, revoked: true },
  });

  return ok({ revoked: true });
});

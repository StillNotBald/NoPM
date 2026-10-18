import { route } from "@/lib/api/handler";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { AuthError } from "@/lib/api/errors";

export const runtime = "nodejs";

export const GET = route(async ({ actor }) => {
  return ok({
    type: actor.type,
    id: actor.id,
    label: actor.label,
    workspaceId: actor.workspaceId,
    role: actor.role ?? null,
    scopes: actor.scopes ?? null,
  });
});

/**
 * PATCH /api/me — update the caller's display_name.
 * Validates non-empty display_name, updates the profiles row scoped to the
 * actor's workspace, writes one audit row, and returns the updated identity.
 */
export const PATCH = route(async ({ actor, request }) => {
  if (actor.type !== "user") {
    throw new AuthError("Only user sessions can update their profile");
  }

  const body = await safeJson<{ display_name?: unknown }>(request);
  const rawName = body?.display_name;
  if (typeof rawName !== "string" || rawName.trim() === "") {
    return validationError("display_name must be a non-empty string", [
      { field: "display_name", message: "Required" },
    ]);
  }
  const displayName = rawName.trim();

  const db = createAdminClient();

  // Fetch current value for audit before-snapshot
  const { data: before } = await db
    .from("profiles")
    .select("display_name")
    .eq("id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  const { data: updated, error } = await db
    .from("profiles")
    .update({ display_name: displayName })
    .eq("id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .select("display_name, role, workspace_id")
    .maybeSingle();

  if (error) throw error;
  if (!updated) return validationError("Profile not found");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "profile.update",
    targetType: "profile",
    targetId: actor.id,
    before: { display_name: before?.display_name ?? null },
    after: { display_name: displayName },
  });

  return ok({
    type: actor.type,
    id: actor.id,
    label: displayName,
    workspaceId: updated.workspace_id,
    role: updated.role ?? null,
  });
});

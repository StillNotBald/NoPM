import { route } from "@/lib/api/handler";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate } from "@/lib/audit/audited-write";
import { AuthError, NotFoundError } from "@/lib/api/errors";

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

  // Fetch current value for the audit before-snapshot
  const db = createAdminClient();
  const { data: before } = await db
    .from("profiles")
    .select("display_name")
    .eq("id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  // The update and its audit row are one transaction (nopm_mutate_audited, migration 0103).
  let updated: Record<string, unknown>;
  try {
    ({ after: updated } = await auditedUpdate({
      table: "profiles",
      actor,
      action: "profile.update",
      id: actor.id,
      patch: { display_name: displayName },
      auditBefore: { display_name: before?.display_name ?? null },
      auditAfter: { display_name: displayName },
    }));
  } catch (e) {
    if (e instanceof NotFoundError) return validationError("Profile not found");
    throw e;
  }

  return ok({
    type: actor.type,
    id: actor.id,
    label: displayName,
    workspaceId: updated.workspace_id,
    role: updated.role ?? null,
  });
});

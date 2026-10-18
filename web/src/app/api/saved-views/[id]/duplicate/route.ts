import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { created, safeJson } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { isVisibleToActor } from "../../_visibility";

export const runtime = "nodejs";

/**
 * POST /api/saved-views/[id]/duplicate — clone any visible view (including
 * a protected one) into a fresh, UNPROTECTED personal copy owned by the
 * caller (saved_view:write). This is the L-07 acceptance criterion "a
 * protected view can still be duplicated into a personal copy" — protection
 * guards the ORIGINAL's config from silent edit, it never blocks someone
 * from forking their own working copy of it.
 *
 * Only a user session can own the resulting personal copy — a token/agent
 * actor has no profiles row to own it with (same rule POST /api/saved-views
 * and PATCH enforce), so this endpoint 422s for token callers rather than
 * silently downgrading the copy to shared (a "duplicate" that lands in a
 * different scope than requested would be a surprising, not obviously
 * correct, default).
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "saved_view:write");

  if (actor.type !== "user") {
    throw new RuleError(
      "Only a user session can duplicate a saved view into a personal copy — token/agent actors have no owning identity",
      "no_owning_identity",
    );
  }

  const db = createAdminClient();

  const { data: source, error: fetchError } = await db
    .from("saved_views")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!source || !isVisibleToActor(source, actor.id)) throw new NotFoundError("Saved view not found");

  const body = await safeJson<{ name?: unknown }>(request);
  const name =
    typeof body?.name === "string" && body.name.trim() ? body.name.trim() : `${source.name} (copy)`;

  const now = new Date().toISOString();
  const { data: row, error } = await db
    .from("saved_views")
    .insert({
      workspace_id: actor.workspaceId,
      owner_id: actor.id,
      register: source.register,
      name,
      config: source.config,
      scope: "personal",
      protected: false,
      updated_at: now,
    })
    .select()
    .single();

  if (error) throw error;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "saved_view.create",
    targetType: "saved_view",
    targetId: row.id,
    before: null,
    after: { ...row, duplicated_from: source.id },
  });

  return created(row);
});

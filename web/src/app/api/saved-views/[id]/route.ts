import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate, auditedDelete } from "@/lib/audit/audited-write";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, ScopeError } from "@/lib/api/errors";
import { updateSavedViewSchema } from "../_schema";
import { isVisibleToActor, canActorMutate, assertConfigMutable, resolveAuditAction } from "../_visibility";

export const runtime = "nodejs";

// GET /api/saved-views/[id] — fetch one saved view (saved_view:read).
// Returns 404 (not 403) for a personal view the caller doesn't own — same
// non-leaking shape as "not found" elsewhere in the API, so an id probe
// can't distinguish "doesn't exist" from "exists but isn't yours".
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "saved_view:read");

  const db = createAdminClient();
  const { data, error } = await db
    .from("saved_views")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data || !isVisibleToActor(data, actor.id)) throw new NotFoundError("Saved view not found");

  return ok(data);
});

/**
 * PATCH /api/saved-views/[id] — partial update (saved_view:write).
 *
 * Governance:
 *  - not visible to the actor → 404 (same non-leaking shape as GET)
 *  - visible but not owned (and actor isn't an admin/isn't the shared-view-
 *    managing token) → 403 (canActorMutate)
 *  - protected view + a config change that doesn't ALSO unprotect → 403
 *    (assertConfigMutable — L-07)
 *  - otherwise: exactly one audit row, action name resolved by
 *    resolveAuditAction (create/update/shared/protected verbs — L-06/L-07)
 */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "saved_view:write");

  const db = createAdminClient();

  const { data: before, error: fetchError } = await db
    .from("saved_views")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before || !isVisibleToActor(before, actor.id)) throw new NotFoundError("Saved view not found");

  const body = await safeJson(request);
  const parsed = updateSavedViewSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid saved view data",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  if (!canActorMutate(before, actor)) {
    throw new ScopeError("Only this view's owner or a workspace admin may change it", "not_view_owner");
  }

  assertConfigMutable(before, parsed.data);

  // Making a view personal requires SOME owner to make it private for. This
  // rejects two related paths with the same friendly 422 instead of letting
  // either fall through to the DB's saved_views_personal_needs_owner CHECK
  // (which would raise an opaque 500, not a clean validation error):
  //   1. a token/agent actor requesting scope:personal — a token has no
  //      profiles row to own it with (mirrors the identical POST-time rule).
  //   2. a HUMAN admin trying to privatize a token-authored SHARED view
  //      (owner_id already null) — there is no identity to hand private
  //      ownership to; reassigning it to the admin silently would be a
  //      surprising side-effect, not a documented one, so this is refused
  //      rather than guessed.
  if (parsed.data.scope === "personal" && (actor.type === "token" || before.owner_id === null)) {
    return validationError(
      actor.type === "token"
        ? "Token/agent actors cannot make a saved view personal — they have no owning identity"
        : "This view has no owner to make it personal for (it was created by a token/agent actor) — duplicate it into a personal copy instead",
      [{ field: "scope", message: "cannot be 'personal' without an owning identity" }],
    );
  }

  const action = resolveAuditAction(parsed.data);

  const now = new Date().toISOString();
  // Row and audit row are one transaction (nopm_mutate_audited).
  const { after } = await auditedUpdate({
    table: "saved_views",
    actor,
    action,
    id: params.id,
    patch: {
      ...parsed.data,
      owner_id: before.owner_id, // ownership never transfers via PATCH
      updated_at: now,
    },
    notFoundMessage: "Saved view not found",
  });

  return ok(after);
});

/**
 * DELETE /api/saved-views/[id] — plain single-step hard delete
 * (saved_view:write). Not maker-checker: saved views behave like
 * milestones/risks/issues/programs here — the four-eyes flow stays
 * PROJECTS ONLY (Decision 3, requirements/devops-wave1/README.md).
 */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "saved_view:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("saved_views")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing || !isVisibleToActor(existing, actor.id)) throw new NotFoundError("Saved view not found");

  if (!canActorMutate(existing, actor)) {
    throw new ScopeError("Only this view's owner or a workspace admin may delete it", "not_view_owner");
  }

  // Row and audit row are one transaction (nopm_mutate_audited).
  await auditedDelete({
    table: "saved_views",
    actor,
    action: "saved_view.delete",
    id: params.id,
    notFoundMessage: "Saved view not found",
  });

  return noContent();
});

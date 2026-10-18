import { route } from "@/lib/api/handler";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePrincipal } from "@/lib/governance/decide";
import { throwImplementRpcError } from "@/lib/governance/implement";
import { auditRpcArgs } from "@/lib/governance/rebaseline-rpc";
import { implementActionSchema } from "@/app/api/change-requests/_schema";

export const runtime = "nodejs";

/**
 * POST /api/change-requests/:id/implement (M2, assumption A2)
 * Mark an APPROVED change request as implemented (live). Body (optional):
 * `{ note }`. The status change, the implemented_at / implemented_by* stamp and the
 * `change_request.implement` audit row are ONE database transaction
 * (nopm_implement_change_request, migration 0092). implemented_at can never be
 * earlier than decided_at (CHECK cr_implemented_after_decision).
 * Scope: change:write. Allowed for the requester's person, or a manager or admin.
 *   403 no_principal  - a token with no recorded owner
 *   403 not_requester - neither the requester nor a manager/admin
 *   404               - not found in this workspace
 *   422 invalid_transition  - the request is not approved
 *   422 already_implemented - a repeat call: it is never re-stamped
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "change:write");

  const body = (await safeJson(request)) ?? {};
  const parsed = implementActionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const principal = requirePrincipal(actor);
  const note = parsed.data.note?.trim() ? parsed.data.note.trim() : null;

  const db = createAdminClient();
  const { data, error } = await db.rpc("nopm_implement_change_request", {
    p_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_note: note,
    p_principal_id: principal,
    ...auditRpcArgs(actor),
  });
  if (error) throwImplementRpcError(error);
  return ok(data as Record<string, unknown>);
});

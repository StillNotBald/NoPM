import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { RAISE_TIME_STATUSES, updateChangeRequestSchema } from "@/app/api/change-requests/_schema";
import {
  actorLabel,
  announceChanged,
  announceDecided,
  changeRequestEvent,
  requireMakerPrincipal,
} from "@/lib/governance/decide";
import { changedMaterialFields } from "@/lib/governance/change-request-edit";

export const runtime = "nodejs";

/**
 * A change request is editable (PATCH) and deletable (DELETE) only while it is
 * still open — `raised` / `under_review`. Once decided (approved / rejected /
 * deferred / implemented) it is part of the decision record: editing its
 * impact_cost after approval, or hard-deleting a rejected one, would rewrite
 * what the decider actually looked at (red-team R1/M6). A decided request is
 * corrected by raising a new one. The write itself is a compare-and-set on the
 * open statuses, so a decision landing between our read and our write wins.
 */
const OPEN_STATUSES = [...RAISE_TIME_STATUSES];

function assertStillOpen(status: string, verb: "edited" | "deleted"): void {
  if (!OPEN_STATUSES.includes(status as (typeof OPEN_STATUSES)[number])) {
    throw new RuleError(
      `This change request is ${status} and is part of the decision record, so it can no longer be ${verb} — raise a new change request instead.`,
      "change_request_decided",
    );
  }
}

/**
 * Four-eyes needs the content an approver decides on to be the requester's, not
 * the approver's: anyone with change:write could otherwise rewrite a pending
 * request and then approve what they wrote. So an open request is edited or
 * deleted only by the requester's PERSON (the user, or a token that user minted).
 * A legacy request with no recorded requester has nobody to compare with.
 */
function assertRequester(existing: { requested_principal_id?: string | null }, editor: string): void {
  if (existing.requested_principal_id && existing.requested_principal_id !== editor) {
    throw new ScopeError("Only the requester can edit an open change request; raise a new one instead", "not_requester");
  }
}

/** GET /api/change-requests/:id — fetch a single change request */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "change:read");

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("change_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!row) throw new NotFoundError("Change request not found");

  return ok(row);
});

/** PATCH /api/change-requests/:id — update a change request */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "change:write");
  const editor = requireMakerPrincipal(actor);

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("change_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Change request not found");

  assertStillOpen(existing.status, "edited");
  assertRequester(existing, editor);

  const body = await safeJson(request);
  const parsed = updateChangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.category !== undefined) updates.category = input.category;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.impact_summary !== undefined) updates.impact_summary = input.impact_summary;
  if (input.impact_schedule_days !== undefined) updates.impact_schedule_days = input.impact_schedule_days;
  if (input.impact_cost !== undefined) updates.impact_cost = input.impact_cost;
  if (input.target_date !== undefined) updates.target_date = input.target_date;
  if (input.raised_at !== undefined) updates.raised_at = input.raised_at;

  const { data: updated, error: updateError } = await db
    .from("change_requests")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .in("status", OPEN_STATUSES)
    .select()
    .maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) {
    // Decided (or deleted) between our read and our write.
    throw new RuleError("This change request was decided while you were editing it.", "change_request_decided");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "change_request.update",
    targetType: "change_request",
    targetId: updated.id,
    before: existing,
    after: updated,
  });

  // Bait-and-switch guard: if the edit changed anything an approver decides on,
  // the approval cards already sent describe content that no longer exists. The
  // table's trigger has bumped updated_at (the content version, which a decision
  // can pin via expected_updated_at); tell the hub so the old card is retired and
  // approvers get a fresh one. Never throws, runs after the audit row.
  if (changedMaterialFields(existing, updates).length > 0) {
    announceChanged(await changeRequestEvent(db, actor.workspaceId, updated));
  }

  return ok(updated);
});

/** DELETE /api/change-requests/:id — delete a change request */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "change:write");
  const editor = requireMakerPrincipal(actor);

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("change_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Change request not found");

  assertStillOpen(existing.status, "deleted");
  assertRequester(existing, editor);

  const { data: removed, error: deleteError } = await db
    .from("change_requests")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .in("status", OPEN_STATUSES)
    .select("id");

  if (deleteError) throw new Error(deleteError.message);
  if (!removed || removed.length === 0) {
    throw new RuleError("This change request was decided while you were deleting it.", "change_request_decided");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "change_request.delete",
    targetType: "change_request",
    targetId: existing.id,
    before: existing,
    after: null,
  });

  // An open request that is deleted still has approval cards out. Close them like
  // a withdrawal: their tokens die and the cards are patched, instead of sitting
  // in chat with live buttons that answer "no longer exists". Never throws; it
  // runs after the delete and its audit row are committed.
  try {
    const base = await changeRequestEvent(db, actor.workspaceId, existing);
    announceDecided({
      ...base,
      status: "withdrawn",
      decidedByLabel: actorLabel(actor),
      channel: actor.channel ?? (actor.type === "token" ? "api" : "ui"),
    });
  } catch (err) {
    console.error("[change-requests] could not announce the deletion to the integration hub", err);
  }

  return noContent();
});

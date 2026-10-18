import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, PreconditionFailedError } from "@/lib/api/errors";
import { checkOptimisticConcurrency } from "@/lib/api/occ";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { updateRiskSchema } from "@/app/api/risks/_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { notify, resolveProjectOwner } from "@/lib/notify/publish";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { RESOLUTION_NOTE_MESSAGE, needsResolutionNote, rankIncreased } from "@/lib/work/resolution";

export const runtime = "nodejs";

/** GET /api/risks/:id — fetch a single risk */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "risk:read");

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("risks")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!row) throw new NotFoundError("Risk not found");

  return ok(row);
});

/** PATCH /api/risks/:id — update a risk */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "risk:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("risks")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Risk not found");

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, updateRiskSchema);
  if (unknown) return unknown;
  const parsed = updateRiskSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  // Q-WRK-19: closing a risk needs a short note on how it was resolved.
  if (
    input.status === "closed" &&
    existing.status !== "closed" &&
    needsResolutionNote(input.resolution !== undefined ? input.resolution : existing.resolution)
  ) {
    return validationError(RESOLUTION_NOTE_MESSAGE, [{ field: "resolution", message: RESOLUTION_NOTE_MESSAGE }]);
  }

  // Cross-tenant guard: owner_id is a profile and must belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "profiles", id: input.owner_id, field: "owner_id" },
  ]);

  // Optimistic concurrency (R-90) — opt-in via expected_updated_at. No-op when
  // the caller doesn't send it (today's last-write-wins, unchanged).
  checkOptimisticConcurrency(existing.updated_at, input.expected_updated_at);

  // Build only the fields provided in the patch
  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.severity !== undefined) updates.severity = input.severity;
  if (input.likelihood !== undefined) updates.likelihood = input.likelihood;
  if (input.category !== undefined) updates.category = input.category;
  if (input.mitigation !== undefined) updates.mitigation = input.mitigation;
  if (input.owner_id !== undefined) updates.owner_id = input.owner_id;
  if (input.status !== undefined) updates.status = input.status;
  if (input.raised_at !== undefined) updates.raised_at = input.raised_at;
  if (input.due_date !== undefined) updates.due_date = input.due_date;
  // content-enrichment (0008)
  if (input.probability_pct !== undefined) updates.probability_pct = input.probability_pct;
  if (input.impact_score !== undefined) updates.impact_score = input.impact_score;
  if (input.response_strategy !== undefined) updates.response_strategy = input.response_strategy;
  if (input.risk_category !== undefined) updates.risk_category = input.risk_category;
  if (input.impact_area !== undefined) updates.impact_area = input.impact_area;
  if (input.trigger !== undefined) updates.trigger = input.trigger;
  if (input.residual_risk !== undefined) updates.residual_risk = input.residual_risk;
  if (input.resolution !== undefined) updates.resolution = input.resolution;
  // ── complement seam (0041, R-81) ────────────────────────────────────────────
  if (input.source !== undefined) updates.source = input.source;
  if (input.external_ref !== undefined) updates.external_ref = input.external_ref;
  if (input.external_url !== undefined) updates.external_url = input.external_url;

  let query = db
    .from("risks")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);
  // Defense-in-depth: also scope the write itself to the row's pre-check
  // updated_at, closing the (narrow) race between the fetch above and this
  // write. On a lost race the row exists but the filter matches zero rows —
  // maybeSingle() returns null instead of PostgREST's "no rows" error.
  if (input.expected_updated_at !== undefined) {
    query = query.eq("updated_at", existing.updated_at);
  }
  const { data: updated, error: updateError } = await query.select().maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) {
    if (input.expected_updated_at !== undefined) {
      throw new PreconditionFailedError("Record changed since you loaded it");
    }
    throw new Error("Update failed");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "risk.update",
    targetType: "risk",
    targetId: updated.id,
    before: existing,
    after: updated,
  });

  // Same alert as on create — and on EVERY later increase (Q-WRK-19): the owner
  // hears when severity or likelihood goes up, not only when it first reaches
  // high or critical. Fail-soft.
  const severityUp = input.severity !== undefined && rankIncreased(existing.severity, input.severity);
  const likelihoodUp = input.likelihood !== undefined && rankIncreased(existing.likelihood, input.likelihood);
  if (
    severityUp ||
    likelihoodUp ||
    (input.severity !== undefined &&
      input.severity !== existing.severity &&
      (input.severity === "high" || input.severity === "critical"))
  ) {
    const projectId = updated.project_id as string;
    void resolveProjectOwner(actor.workspaceId, projectId).then((ownerId) => {
      if (!ownerId) return;
      return notify({
        workspaceId: actor.workspaceId,
        recipientIds: [ownerId],
        type: "risk.escalated",
        title: `${String(updated.severity).toUpperCase()} risk raised: ${updated.title}`,
        body: updated.description ?? undefined,
        payload: { riskId: updated.id, projectId, severity: updated.severity, refId: updated.reference_id },
      });
    });
  }

  return ok(updated);
});

/** DELETE /api/risks/:id — delete a risk */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "risk:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("risks")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Risk not found");

  const { error: deleteError } = await db
    .from("risks")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw new Error(deleteError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "risk.delete",
    targetType: "risk",
    targetId: existing.id,
    before: existing,
    after: null,
  });

  return noContent();
});

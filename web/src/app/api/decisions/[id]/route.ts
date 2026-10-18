import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { updateDecisionSchema } from "@/app/api/decisions/_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import {
  DECISION_LOCKED_MESSAGE,
  DECISION_NO_DELETE_MESSAGE,
  assertMayAccept,
  assertNoSupersedeLoop,
  isFrozen,
  markReplacedSuperseded,
} from "@/app/api/decisions/_rules";

export const runtime = "nodejs";

/** GET /api/decisions/:id — fetch a single decision */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "decision:read");

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("decisions")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!row) throw new NotFoundError("Decision not found");

  return ok(row);
});

/** PATCH /api/decisions/:id — update a decision */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "decision:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("decisions")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Decision not found");

  const body = await safeJson(request);
  const parsed = updateDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  // Q-GOV-15: once accepted (or replaced) a decision is on record and is not edited.
  if (isFrozen(existing.status)) {
    throw new RuleError(DECISION_LOCKED_MESSAGE, "decision_accepted_locked");
  }
  // Decision 25 / Q-REV-18: only managers and admins mark a decision accepted.
  assertMayAccept(actor, input.status);

  if (input.supersedes === params.id) {
    return validationError("Validation failed", [
      { field: "supersedes", message: "a decision cannot supersede itself" },
    ]);
  }
  // Cross-tenant guard: `supersedes` is a decision and must belong to THIS
  // workspace (see the matching note on POST /api/projects/:id/decisions).
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "decisions", id: input.supersedes, field: "supersedes" },
  ]);
  if (input.supersedes) {
    await assertNoSupersedeLoop(db, actor.workspaceId, input.supersedes, params.id);
  }

  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.context !== undefined) updates.context = input.context;
  if (input.options !== undefined) updates.options = input.options;
  if (input.decision !== undefined) updates.decision = input.decision;
  if (input.rationale !== undefined) updates.rationale = input.rationale;
  if (input.status !== undefined) updates.status = input.status;
  if (input.decided_at !== undefined) updates.decided_at = input.decided_at;
  if (input.supersedes !== undefined) updates.supersedes = input.supersedes;
  // ── complement seam (0041, R-81) ────────────────────────────────────────────
  if (input.source !== undefined) updates.source = input.source;
  if (input.external_ref !== undefined) updates.external_ref = input.external_ref;
  if (input.external_url !== undefined) updates.external_url = input.external_url;

  const { data: updated, error: updateError } = await db
    .from("decisions")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "decision.update",
    targetType: "decision",
    targetId: updated.id,
    before: existing,
    after: updated,
  });

  // Q-GOV-15: becoming accepted while replacing an earlier decision supersedes it.
  const replaced = updated.supersedes as string | null;
  if (updated.status === "accepted" && replaced) {
    await markReplacedSuperseded(db, actor, replaced, updated.id);
  }

  return ok(updated);
});

/** DELETE /api/decisions/:id — delete a decision */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "decision:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("decisions")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Decision not found");

  // Q-GOV-15: a recorded decision is never hard-deleted; supersede it with a new one.
  if (isFrozen(existing.status)) {
    throw new RuleError(DECISION_NO_DELETE_MESSAGE, "decision_accepted_locked");
  }

  // decisions.supersedes is a NO ACTION foreign key: deleting a decision that
  // another decision supersedes used to fail with a raw 500. Say so instead.
  const { data: dependent, error: dependentError } = await db
    .from("decisions")
    .select("id, reference_id")
    .eq("workspace_id", actor.workspaceId)
    .eq("supersedes", params.id)
    .limit(1)
    .maybeSingle();
  if (dependentError) throw new Error(dependentError.message);
  if (dependent) {
    throw new RuleError(
      `Decision is superseded by ${dependent.reference_id ?? dependent.id} — remove that link before deleting it`,
      "decision_in_use",
    );
  }

  const { error: deleteError } = await db
    .from("decisions")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  // 23503 = foreign_key_violation: something we cannot see from this workspace
  // still points here (a link written before cross-tenant references were
  // refused). A rule failure, not a server error.
  if (deleteError?.code === "23503") {
    throw new RuleError("Decision is still referenced by another record", "decision_in_use");
  }
  if (deleteError) throw new Error(deleteError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "decision.delete",
    targetType: "decision",
    targetId: existing.id,
    before: existing,
    after: null,
  });

  return noContent();
});

import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { notify } from "@/lib/notify/publish";
import {
  assertDecidable,
  assertNotSelfDecision,
  assertRationaleOnReject,
} from "@/lib/governance/timesheet-decision";
import { timesheetDecisionSchema } from "../../_schema";

export const runtime = "nodejs";

/**
 * POST /api/timesheet-submissions/:id/decision
 * Four-eyes (L-31, Template B): record an approve/reject decision on a
 * timesheet submission.
 * Guards (D2, f2b-specs.md):
 *   - Submission must be in status 'submitted' (else RuleError 422)
 *   - Deciding actor must differ from the submitter — COMPOUND (id AND type)
 *     comparison — on BOTH approve and reject (ScopeError 403, guard symmetry)
 *   - Rejection requires a non-empty rationale (RuleError 422)
 * Effect:
 *   1. Update status -> approved | rejected; set decided_by/_type/_label, decided_at, decision_rationale
 *   2. writeAudit timesheet.approved | timesheet.rejected (fail-closed)
 *   3. notify the submitter — fail-soft
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "time:approve");

  const db = createAdminClient();

  const { data: submission, error: fetchError } = await db
    .from("timesheet_submissions")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!submission) throw new NotFoundError("Timesheet submission not found");

  assertDecidable(submission.status);
  assertNotSelfDecision(submission, actor);

  const body = await safeJson(request);
  const parsed = timesheetDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const { decision, rationale } = parsed.data;
  assertRationaleOnReject(decision, rationale);

  const now = new Date().toISOString();

  const { data: updated, error: updateError } = await db
    .from("timesheet_submissions")
    .update({
      status: decision,
      decided_by: actor.id,
      decided_by_type: actor.type,
      decided_by_label: actor.label,
      decided_at: now,
      decision_rationale: rationale ?? null,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  // Single governance row per decision — domain rows were written at submit
  // time (time.create on each entry); this is the governance step itself.
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: decision === "approved" ? "timesheet.approved" : "timesheet.rejected",
    targetType: "timesheet_submission",
    targetId: updated.id,
    before: { status: submission.status },
    after: { status: updated.status, decision_rationale: updated.decision_rationale },
  });

  // Notify the submitter of the decision — fail-soft.
  void notify({
    workspaceId: actor.workspaceId,
    recipientIds: [submission.submitted_by],
    type: decision === "approved" ? "approval.approved" : "approval.rejected",
    title: `Your timesheet (week of ${submission.period_start}) was ${decision}`,
    body: rationale ?? undefined,
    payload: { timesheetSubmissionId: updated.id, decision },
  });

  return ok(updated);
});

import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import {
  assertDecidable,
  assertReopenable,
  assertNotSelfDecision,
  assertRationaleOnReject,
} from "@/lib/governance/timesheet-decision";
import { timesheetDecisionSchema } from "../../_schema";

export const runtime = "nodejs";

/**
 * POST /api/timesheet-submissions/:id/decision
 * Four-eyes (L-31, Template B): record an approve/reject/reopen decision on
 * a timesheet submission. "reopened" (R-76/L-32) is the governed unlock
 * verb for the period-close lock — it reverts an approved (and therefore
 * locked, per migration 20260815000040) week back to 'submitted' so time
 * entries can be created/deleted in it again.
 *
 * Guards (D2, f2b-specs.md; extended R-76 for reopen):
 *   - approve/reject: submission must be in status 'submitted' (assertDecidable, else 422)
 *   - reopen: submission must be in status 'approved' (assertReopenable, else 422) — the INVERSE precondition
 *   - ALL THREE verbs: deciding actor must differ from the submitter — COMPOUND
 *     (id AND type) comparison (ScopeError 403, guard symmetry — self-reopen
 *     is blocked exactly like self-approve/self-reject)
 *   - reject AND reopen require a non-empty rationale (RuleError 422); approve does not
 * Effect:
 *   - approve/reject: status -> approved | rejected; decided_by/_type/_label, decided_at, decision_rationale set
 *   - reopen: status -> submitted; decided_by/_type/_label, decided_at, decision_rationale all NULLed
 *     (ts_maker_checker is CHECK-safe: 'submitted' is the non-terminal exempt status) — the sheet is a
 *     fresh row awaiting a fresh decision, so the prior decision is fully cleared, not just superseded
 *   - writeAudit timesheet.approved | timesheet.rejected | timesheet.reopened (fail-closed)
 *   - notify — fail-soft: approve/reject notify the submitter; reopen notifies the workspace's
 *     approvers (the sheet re-enters the Review Queue — that IS a new approval request)
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

  const body = await safeJson(request);
  const parsed = timesheetDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const { decision, rationale } = parsed.data;

  if (decision === "reopened") {
    assertReopenable(submission.status);
  } else {
    assertDecidable(submission.status);
  }
  // Guard symmetry (R-76): the self-decision guard is called identically
  // before ALL THREE verbs, never just approve — see recon-foureyes.md's
  // lesson about a checker-only guard on approve leaving self-reject (and
  // now self-reopen) to hit a raw DB 500 instead of a clean 403.
  assertNotSelfDecision(submission, actor);
  assertRationaleOnReject(decision, rationale);

  const now = new Date().toISOString();

  const { data: updated, error: updateError } = await db
    .from("timesheet_submissions")
    .update(
      decision === "reopened"
        ? {
            status: "submitted",
            decided_by: null,
            decided_by_type: null,
            decided_by_label: null,
            decided_at: null,
            decision_rationale: null,
          }
        : {
            status: decision,
            decided_by: actor.id,
            decided_by_type: actor.type,
            decided_by_label: actor.label,
            decided_at: now,
            decision_rationale: rationale ?? null,
          },
    )
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
    action:
      decision === "approved"
        ? "timesheet.approved"
        : decision === "rejected"
          ? "timesheet.rejected"
          : "timesheet.reopened",
    targetType: "timesheet_submission",
    targetId: updated.id,
    before: { status: submission.status },
    after:
      decision === "reopened"
        ? { status: updated.status, rationale }
        : { status: updated.status, decision_rationale: updated.decision_rationale },
  });

  if (decision === "reopened") {
    // The sheet re-enters the Review Queue as a fresh (unsubmitted-decision)
    // 'submitted' row — that's a new approval request, so it fans out to
    // the workspace's approvers the same way a fresh submission would,
    // rather than notifying the original submitter (who already knows: they
    // are the one who will need to fix/resubmit).
    void resolveWorkspaceApprovers(actor.workspaceId).then((approverIds) =>
      notify({
        workspaceId: actor.workspaceId,
        recipientIds: approverIds,
        type: "approval.requested",
        title: `Timesheet reopened for re-review (week of ${submission.period_start})`,
        body: `Reopened by ${actor.label}: ${rationale}`,
        payload: { timesheetSubmissionId: updated.id, decision },
      }),
    );
  } else {
    // Notify the submitter of the decision — fail-soft.
    void notify({
      workspaceId: actor.workspaceId,
      recipientIds: [submission.submitted_by],
      type: decision === "approved" ? "approval.approved" : "approval.rejected",
      title: `Your timesheet (week of ${submission.period_start}) was ${decision}`,
      body: rationale ?? undefined,
      payload: { timesheetSubmissionId: updated.id, decision },
    });
  }

  return ok(updated);
});

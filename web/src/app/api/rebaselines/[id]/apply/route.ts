import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { assertNotRequesterPrincipal, requirePrincipal } from "@/lib/governance/decide";
import { assertApplicable } from "@/lib/governance/rebaseline-lifecycle";

export const runtime = "nodejs";

/** The project's own baseline dates, as the audit row records them. */
type ProjectBaseline = { start: string | null; target: string | null };

// POST /api/rebaselines/[id]/apply — apply an approved rebaseline (rebaseline:approve)
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "rebaseline:approve");
  // Applying is the checker's act (same scope as sign-off): it needs a human
  // behind the actor, and that human must not be the requester.
  const principal = requirePrincipal(actor);

  const db = createAdminClient();

  // Load rebaseline — must belong to actor's workspace
  const { data: rebaseline, error: fetchError } = await db
    .from("rebaselines")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!rebaseline) throw new NotFoundError("Rebaseline not found");

  // Four-eyes: the requester may not apply a rebaseline they raised (R-04).
  if (actor.type === "user" && rebaseline.requested_by && actor.id === rebaseline.requested_by) {
    throw new RuleError("Four-eyes: you cannot apply a rebaseline you requested.", "self_approval");
  }
  assertNotRequesterPrincipal(
    rebaseline.requested_principal_id,
    principal,
    "Four-eyes: you cannot apply a rebaseline you requested.",
  );

  // Only approved rebaselines may be applied — and only once (R1/M2: an
  // applied rebaseline used to regress to approved after any later vote and
  // could be applied, and re-snapshot the baselines, again).
  assertApplicable(rebaseline.status);

  // ── Re-baseline snapshot ───────────────────────────────────────────────────
  // When a rebaseline is applied, the newly-approved dates become the new
  // baseline: set baseline_* = current schedule dates for all milestones and
  // tasks in the project.  This overwrites any existing baseline (intentional —
  // the governance trail lives in audit_log, not in the column history).
  //
  // Guard: rebaseline.project_id must exist; if the shape ever changes this
  // block is skipped gracefully so the apply itself is never blocked.
  //
  // Runs as a single RPC (nopm_apply_rebaseline_snapshot, migration 0028)
  // rather than a loop of individual `.update()` calls: this project may be
  // locked (that's the normal case — applying a rebaseline is how a locked
  // project's dates legitimately change), and the DB-level lock backstop
  // (migration 0028) enforces that on every task/milestone write. The RPC
  // sets a transaction-local nopm.lock_bypass at its start, which only holds
  // for the one transaction the RPC call opens — a loop of separate
  // supabase-js calls would each open their own transaction and the bypass
  // would not carry across them.
  //
  // It runs BEFORE the status flip: `applied` is terminal (the 0049 trigger
  // refuses any further transition), so flipping first and failing in the
  // snapshot used to strand a rebaseline that was "applied" with its baselines
  // unchanged and no way to retry. The snapshot is idempotent (baseline :=
  // current dates), so a failure here leaves the rebaseline `approved` and a
  // retry simply runs it again.
  //
  // The same RPC also moves the PROJECT's own baseline dates (migration 0055).
  // That is the one change here no child row shows, so the route reads the
  // project baseline either side of the call and records both in the audit row
  // (after.project_baseline): the History tab and the Trust Center stream then
  // show exactly what the baseline was and what the apply made it.
  const projectId: string | null = rebaseline.project_id ?? null;

  const readProjectBaseline = async () => {
    const { data, error } = await db
      .from("projects")
      .select("baseline_start_date, baseline_target_date")
      .eq("id", projectId as string)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (error) throw error;
    return { start: data?.baseline_start_date ?? null, target: data?.baseline_target_date ?? null };
  };

  let projectBaseline: { before: ProjectBaseline; after: ProjectBaseline } | null = null;

  if (projectId) {
    const baselineBefore = await readProjectBaseline();
    const { error: snapshotErr } = await db.rpc("nopm_apply_rebaseline_snapshot", {
      p_project_id: projectId,
      p_workspace_id: actor.workspaceId,
    });
    if (snapshotErr) throw snapshotErr;
    projectBaseline = { before: baselineBefore, after: await readProjectBaseline() };
  }

  const now = new Date().toISOString();

  // Compare-and-set approved -> applied: two concurrent applies can't both win
  // (the rebaselines trigger of migration 0049 is the DB backstop). The loser
  // may have re-run the idempotent snapshot above; that changes nothing.
  const { data: after, error: updateError } = await db
    .from("rebaselines")
    .update({
      status: "applied",
      applied_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("status", "approved")
    .select()
    .maybeSingle();

  if (updateError) throw updateError;
  if (!after) {
    throw new RuleError("This rebaseline has already been applied.", "already_applied");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "rebaseline.apply",
    targetType: "rebaseline",
    targetId: params.id,
    before: rebaseline,
    after: projectBaseline ? { ...after, project_baseline: projectBaseline } : after,
  });

  return ok(after);
});

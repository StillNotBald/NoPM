import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { okList, created, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { LOCK_FIRST_MESSAGE } from "@/lib/governance/rebaseline-rpc";
import { proposeRebaselineAtomic } from "@/lib/governance/atomic-rpc";
import { announceRequested, requireMakerPrincipal } from "@/lib/governance/decide";
import { rebaselineEvent } from "@/lib/integrations/rebaseline-approval";
import { resolveAssignedApprover } from "@/lib/review/assignee";
import { approverRoleFor, classify, deadlineFor, humanRoleOf, loadApprovalPolicy } from "@/lib/governance/tiers";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { createRebaselineSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

// GET /api/projects/[id]/rebaselines — list rebaselines for a project (project:read)
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:read");

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)));
  const offset = (page - 1) * limit;

  const db = createAdminClient();

  // Verify project exists and belongs to workspace
  const { data: project, error: projectError } = await db
    .from("projects")
    .select("id")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (projectError) throw projectError;
  if (!project) throw new NotFoundError("Project not found");

  const { count, error: countError } = await db
    .from("rebaselines")
    .select("id", { count: "exact", head: true })
    .eq("project_id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (countError) throw countError;

  const { data, error } = await db
    .from("rebaselines")
    .select("*")
    .eq("project_id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .order("version", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

// POST /api/projects/[id]/rebaselines — create a rebaseline (project:write)
//
// Proposing is the maker step of the rebaseline four-eyes flow, so the actor
// must have a human behind it (R1/H3): a token with no recorded owner gets 403
// `no_principal` — its requester principal would be null, comparable to nobody,
// and the same person could then sign off their own proposal.
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:write");
  const requesterPrincipal = requireMakerPrincipal(actor);

  const db = createAdminClient();

  // Load project — it must be locked (Q-GOV-4), and its dates are what is proposed (Q-GOV-8)
  const { data: project, error: projectError } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (projectError) throw projectError;
  if (!project) throw new NotFoundError("Project not found");

  // Q-GOV-4: propose only on a locked project. (An unlocked project used to get a
  // 'draft' that could never be signed off; migration 0077 closed the old ones.)
  if (!project.is_locked) throw new RuleError(LOCK_FIRST_MESSAGE, "project_not_locked");

  const body = await safeJson(request);
  const parsed = createRebaselineSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  // G1: the tier comes from the policy, never from the caller.
  const policy = await loadApprovalPolicy(db, actor.workspaceId);
  const { tier } = classify({
    kind: "rebaseline",
    requester_role: humanRoleOf(actor as Parameters<typeof humanRoleOf>[0]),
    policy,
  });
  const deadline = deadlineFor(tier, policy, new Date());
  const assignedApproverId = await resolveAssignedApprover(
    db,
    actor.workspaceId,
    parsed.data.assigned_approver_id,
    requesterPrincipal,
    approverRoleFor(tier, policy),
  );

  // Q-GOV-8: what approvers sign is the exact dates (current baseline -> the project's locked dates, which is what
  // apply copies), recorded by the database function from the locked project row; any free text the proposer sent
  // rides along as `note`. The next version, the row, its rebaseline.create audit row and the deadline_set event are
  // one database transaction (wave 5, R-161). D4 / R-15: a second pending proposal (uniq_pending_rebaseline) and a
  // racing version are told apart by the function's unique-violation text, mapped in proposeRebaselineAtomic.
  const row = await proposeRebaselineAtomic(db, {
    actor,
    projectId: params.id,
    reason: parsed.data.reason,
    tier,
    deadline,
    assignedApproverId,
    requesterPrincipal,
    noteBefore: parsed.data.before,
    noteAfter: parsed.data.after,
  });

  // G2: tell the people who may sign off THIS tier. Fail-soft.
  void resolveWorkspaceApprovers(actor.workspaceId, { tier, assignedApproverId }).then((approverIds) => {
    return notify({
      workspaceId: actor.workspaceId,
      recipientIds: approverIds.filter((id) => id !== requesterPrincipal),
      type: "approval.requested",
      title: `Rebaseline needs sign-off: ${project.name ?? params.id}`,
      body: parsed.data.reason ?? undefined,
      payload: { href: "/approvals", rebaselineId: row.id, tier },
    });
  });

  // Open the Lark sign-off card for the approvers. Fire-and-forget: it runs after the
  // row and its audit row are committed and can never fail the request.
  try {
    announceRequested(await rebaselineEvent(db, actor.workspaceId, row));
  } catch (err) {
    console.error("[rebaselines] could not announce the proposal", err);
  }

  return created(row);
});

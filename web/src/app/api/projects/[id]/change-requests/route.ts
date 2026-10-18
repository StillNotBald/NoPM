import { route } from "@/lib/api/handler";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { ScopeError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify, resolveProjectOwner, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { approverRoleFor, classify, deadlineFor, humanRoleOf, loadApprovalPolicy } from "@/lib/governance/tiers";
import { actorLabel, announceRequested, requireMakerPrincipal } from "@/lib/governance/decide";
import { insertWithReference } from "@/lib/governance/next-ref";
import { raiseChangeRequestRpc } from "@/lib/governance/atomic-rpc";
import { resolveAssignedApprover } from "@/lib/review/assignee";
import { createChangeRequestSchema } from "@/app/api/change-requests/_schema";

export const runtime = "nodejs";

const EMERGENCY_TOKEN_MESSAGE =
  "An API token needs the change:decide scope to raise an emergency change, because nobody else decides it. Use a signed-in manager or admin, or a token that holds change:decide.";

/** GET /api/projects/:id/change-requests — list change requests for a project */
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "change:read");

  const db = createAdminClient();
  const projectId = params.id;

  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  const { data: items, error, count } = await db
    .from("change_requests")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

/**
 * POST /api/projects/:id/change-requests — raise a change request under a project.
 * The maker step of the change-control four-eyes flow: the actor must have a
 * human behind it (R1/H3). A token with no recorded owner gets 403
 * `no_principal` — a null requester principal is comparable to nobody, so the
 * same person could then decide their own request from a session.
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "change:write");
  const requesterPrincipal = requireMakerPrincipal(actor);

  const db = createAdminClient();
  const projectId = params.id;

  const { data: project } = await db
    .from("projects")
    .select("id, name")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const parsed = createChangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  // G1/G7/G4: the tier is decided here, from the policy, never trusted from the caller.
  const policy = await loadApprovalPolicy(db, actor.workspaceId);
  const now = new Date();
  const classified = classify({
    kind: "change_request",
    impact_cost: input.impact_cost,
    impact_schedule_days: input.impact_schedule_days,
    impact_scope_count: input.impact_scope?.length ?? 0,
    is_emergency: input.is_emergency === true,
    requested_tier: input.tier ?? null,
    requester_role: humanRoleOf(actor as Parameters<typeof humanRoleOf>[0]),
    policy,
  });
  const tier = classified.tier;
  const isEmergency = tier === "emergency";
  // C2-01: nobody decides an emergency, so a token may raise one only with the exact change:decide scope
  // (wildcards never grant it). A signed-in manager or admin needs nothing more.
  if (isEmergency && actor.type === "token") {
    try {
      requireScope(actor, "change:decide");
    } catch {
      throw new ScopeError(EMERGENCY_TOKEN_MESSAGE, "role_not_permitted");
    }
  }
  const deadline = deadlineFor(tier, policy, now);
  // Q1: an emergency commits on raise. Nobody decides it, so it has no assigned approver.
  const assignedApproverId = isEmergency
    ? null
    : await resolveAssignedApprover(
        db,
        actor.workspaceId,
        input.assigned_approver_id,
        requesterPrincipal,
        approverRoleFor(tier, policy),
      );
  const baseFields = {
    project_id: projectId,
    title: input.title,
    description: input.description ?? null,
    category: input.category,
    priority: input.priority,
    impact_summary: input.impact_summary ?? null,
    impact_schedule_days: input.impact_schedule_days ?? null,
    impact_cost: input.impact_cost ?? null,
    impact_scope: input.impact_scope ?? null,
    target_date: input.target_date ?? null,
    // raised_at is NOT NULL DEFAULT now() — an explicit null would violate the column; omit the key so the
    // database default applies when the caller does not send one (agents and curl callers rarely do).
    ...(input.raised_at ? { raised_at: input.raised_at } : {}),
    requested_by: actor.type === "user" ? actor.id : null,
    requested_by_label: actor.label,
    requested_by_type: actor.type,
    requested_by_id: actor.id,
  };
  const { data: row, error } = await insertWithReference(db, actor.workspaceId, "change_request", (refId) =>
    isEmergency
      ? // Q1 + C2-03: an emergency commits when raised. The request and both audit rows (create, emergency_commit)
        // are written by one database function in one transaction: a failed audit leaves no request behind.
        db.rpc("nopm_raise_emergency_change_request", {
          p_workspace_id: actor.workspaceId,
          p_input: { ...baseFields, reference_id: refId },
          p_actor_type: actor.type,
          p_actor_id: actor.id,
          p_actor_label: actor.label,
          p_principal_id: requesterPrincipal,
          p_channel: actor.channel ?? null,
          p_correlation_id: actor.requestId ?? null,
          p_via_connector_id: actor.viaConnectorId ?? null,
          p_external_event_id: actor.externalEventId ?? null,
          p_external_actor_ref: actor.externalActorRef ?? null,
        })
      : // Wave 5 (R-161): the request, its change_request.create audit row and the deadline_set event are written by
        // one database function in one transaction. The tier, deadline and approver were decided above. A
        // reference-number clash comes back as 23505 and insertWithReference retries with the next number.
        raiseChangeRequestRpc(db, {
          actor,
          input: { ...baseFields, reference_id: refId, status: input.status },
          tier,
          deadline,
          assignedApproverId,
          requesterPrincipal,
          reason: classified.reason,
        }),
  );

  if (error && (error.code === "P0043" || /EMERGENCY_NOT_PERMITTED/.test(error.message ?? ""))) {
    throw new ScopeError("Only a manager or admin can raise an emergency change.", "role_not_permitted");
  }
  if (error || !row) throw new Error(error?.message ?? "Insert failed");

  // Both paths wrote their audit rows (and the non-emergency deadline_set event) inside the database call above,
  // in one transaction with the request itself.

  // G2: tell the people who may decide THIS tier (an admin tier goes to admins only), not every approver.
  // An emergency has nothing to decide, so no approval request goes out for it.
  if (!isEmergency) {
    void resolveWorkspaceApprovers(actor.workspaceId, { tier, assignedApproverId }).then((approverIds) => {
      return notify({
        workspaceId: actor.workspaceId,
        recipientIds: approverIds.filter((id) => id !== requesterPrincipal),
        type: "approval.requested",
        title: `Change request needs a decision: ${input.title}`,
        body: classified.reason ?? input.description ?? undefined,
        payload: { href: "/approvals", changeRequestId: row.id, tier, refId: row.reference_id },
      });
    });
  }

  // Notify project owner when priority is high or critical — fail-soft
  if (input.priority === "high" || input.priority === "critical") {
    void resolveProjectOwner(actor.workspaceId, projectId).then((ownerId) => {
      if (!ownerId) return;
      return notify({
        workspaceId: actor.workspaceId,
        recipientIds: [ownerId],
        type: "risk.escalated",
        title: `${input.priority.toUpperCase()} change request raised: ${input.title}`,
        body: input.description ?? undefined,
        payload: { changeRequestId: row.id, projectId, priority: input.priority, refId: row.reference_id },
      });
    });
  }

  // Tell the integration hub (chat approval cards) — never throws, runs after
  // the request and its audit row are committed. An emergency has no card: nothing to approve.
  if (!isEmergency) announceRequested({
    workspaceId: actor.workspaceId,
    kind: "change_request",
    id: row.id,
    title: `Change request ${row.reference_id ?? row.id}: ${input.title}`,
    summary: input.impact_summary ?? input.description ?? null,
    projectId,
    projectName: project.name ?? null,
    requestedByLabel: actorLabel(actor),
    requesterPrincipalId: requesterPrincipal,
    tier,
    ...(assignedApproverId ? { assignedApproverId } : {}),
    // The version this card describes: the hub binds the card's buttons to it, so an
    // edit that lands before the card goes out cannot be approved unseen.
    version: row.updated_at ?? null,
  });

  return created(row);
});

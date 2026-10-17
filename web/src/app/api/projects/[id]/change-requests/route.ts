import { route } from "@/lib/api/handler";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { notify, resolveProjectOwner } from "@/lib/notify/publish";
import { actorLabel, announceRequested, requireMakerPrincipal } from "@/lib/governance/decide";
import { insertWithReference } from "@/lib/governance/next-ref";
import { createChangeRequestSchema } from "@/app/api/change-requests/_schema";

export const runtime = "nodejs";

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
  const { data: row, error } = await insertWithReference(db, actor.workspaceId, "change_request", (refId) => db
    .from("change_requests")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: projectId,
      reference_id: refId,
      title: input.title,
      description: input.description ?? null,
      category: input.category,
      priority: input.priority,
      status: input.status,
      impact_summary: input.impact_summary ?? null,
      impact_schedule_days: input.impact_schedule_days ?? null,
      impact_cost: input.impact_cost ?? null,
      target_date: input.target_date ?? null,
      // raised_at is NOT NULL DEFAULT now() — an explicit null would violate
      // the column; omit the key so the database default applies when the
      // caller does not send one (agents and curl callers rarely do).
      ...(input.raised_at ? { raised_at: input.raised_at } : {}),
      requested_by: actor.type === "user" ? actor.id : null,
      requested_by_label: actor.label,
      requested_by_type: actor.type,
      requested_by_id: actor.id,
      // The HUMAN behind the requester (the user, or the token's creator) —
      // four-eyes compares this, not the actor id.
      requested_principal_id: requesterPrincipal,
    })
    .select()
    .single());

  if (error || !row) throw new Error(error?.message ?? "Insert failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "change_request.create",
    targetType: "change_request",
    targetId: row.id,
    before: null,
    after: row,
  });

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
  // the request and its audit row are committed.
  announceRequested({
    workspaceId: actor.workspaceId,
    kind: "change_request",
    id: row.id,
    title: `Change request ${row.reference_id ?? row.id}: ${input.title}`,
    summary: input.impact_summary ?? input.description ?? null,
    projectId,
    projectName: project.name ?? null,
    requestedByLabel: actorLabel(actor),
    requesterPrincipalId: requesterPrincipal,
    // The version this card describes: the hub binds the card's buttons to it, so an
    // edit that lands before the card goes out cannot be approved unseen.
    version: row.updated_at ?? null,
  });

  return created(row);
});

import { route } from "@/lib/api/handler";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { insertWithReference } from "@/lib/governance/next-ref";
import { createDecisionSchema } from "@/app/api/decisions/_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { assertMayAccept, isApproverRole, markReplacedSuperseded } from "@/app/api/decisions/_rules";

export const runtime = "nodejs";

/**
 * GET /api/projects/:id/decisions — list decisions for a project.
 * Filters: source, external_ref (complement seam, R-81 — both exact-match).
 */
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "decision:read");

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
  const source = url.searchParams.get("source");
  const externalRef = url.searchParams.get("external_ref");

  let query = db
    .from("decisions")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", projectId);
  if (source) query = query.eq("source", source);
  if (externalRef) query = query.eq("external_ref", externalRef);
  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data: items, error, count } = await query;

  if (error) throw new Error(error.message);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

/** POST /api/projects/:id/decisions — log a decision under a project */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "decision:write");

  const db = createAdminClient();
  const projectId = params.id;

  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const parsed = createDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  // Decision 25 / Q-REV-18: anyone can propose; only managers and admins mark accepted.
  // Omitted status = accepted for them, proposed for everyone else.
  assertMayAccept(actor, input.status);
  const status = input.status ?? (isApproverRole(actor) ? "accepted" : "proposed");

  // Cross-tenant guard: `supersedes` is a decision and must belong to THIS
  // workspace. An unchecked foreign id used to be accepted, and the NO ACTION
  // foreign key then made the OTHER tenant's delete of its own decision fail
  // with a 500.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "decisions", id: input.supersedes, field: "supersedes" },
    // B1: the linked change request must be in this workspace AND on this project.
    { table: "change_requests", id: input.change_request_id, field: "change_request_id", match: { project_id: projectId } },
  ]);

  const { data: row, error } = await insertWithReference(db, actor.workspaceId, "decision", (refId) => db
    .from("decisions")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: projectId,
      reference_id: refId,
      title: input.title,
      context: input.context ?? null,
      options: input.options ?? null,
      decision: input.decision ?? null,
      rationale: input.rationale ?? null,
      status,
      decided_by: actor.type === "user" ? actor.id : null,
      decided_by_label: actor.label,
      decided_at: input.decided_at ?? new Date().toISOString(),
      supersedes: input.supersedes ?? null,
      change_request_id: input.change_request_id ?? null,
      options_structured: input.options_structured ?? null,
      // ── complement seam (0041, R-81) ─────────────────────────────────────────
      source: input.source ?? null,
      external_ref: input.external_ref ?? null,
      external_url: input.external_url ?? null,
    })
    .select()
    .single());

  if (error || !row) throw new Error(error?.message ?? "Insert failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "decision.create",
    targetType: "decision",
    targetId: row.id,
    before: null,
    after: row,
  });

  // Q-GOV-15: an accepted decision that replaces an earlier one marks it superseded.
  if (status === "accepted" && input.supersedes) {
    await markReplacedSuperseded(db, actor, input.supersedes, row.id);
  }

  return created(row);
});

import { route } from "@/lib/api/handler";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { notify, resolveProjectOwner } from "@/lib/notify/publish";
import { createRiskSchema } from "@/app/api/risks/_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { nextRefId } from "@/lib/ref-id";
import { parseSort, orderOptions } from "@/lib/api/sort";
import { RISK_SORT_FIELDS, parseRiskFilters } from "@/app/api/risks/_query";

export { RISK_SORT_FIELDS };

export const runtime = "nodejs";

/** GET /api/projects/:id/risks — list risks for a project */
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "risk:read");

  const db = createAdminClient();
  const projectId = params.id;

  // Verify the project belongs to this workspace
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

  // Reject an unknown sort field/direction before touching the DB.
  const sort = parseSort(url.searchParams.get("sort"), RISK_SORT_FIELDS, {
    field: "created_at",
    ascending: false,
  });

  const filters = parseRiskFilters(url.searchParams);

  let query = db
    .from("risks")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", projectId);

  // Inlined (not applyRiskFilters<Q>/applySort<Q>): the generic helpers trip
  // TS2589 against this route's concrete builder type — same workaround as the
  // issues/audit/time-entries/export routes. parseRiskFilters/parseSort stay
  // the single source of truth for param mapping + whitelist.
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.severity) query = query.eq("severity", filters.severity);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.external_ref) query = query.eq("external_ref", filters.external_ref);
  query = query.order(sort.field, orderOptions(sort));
  query = query.range(offset, offset + limit - 1);

  const { data: items, error, count } = await query;

  if (error) throw new Error(error.message);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

/** POST /api/projects/:id/risks — create a risk under a project */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "risk:write");

  const db = createAdminClient();
  const projectId = params.id;

  // Verify the project belongs to this workspace
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const parsed = createRiskSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  // Cross-tenant guard: owner_id is a profile and must belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "profiles", id: input.owner_id, field: "owner_id" },
  ]);

  const refId = await nextRefId(db, actor.workspaceId, "risks", "R");

  const { data: row, error } = await db
    .from("risks")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: projectId,
      reference_id: refId,
      title: input.title,
      description: input.description ?? null,
      severity: input.severity,
      likelihood: input.likelihood,
      category: input.category ?? null,
      mitigation: input.mitigation ?? null,
      owner_id: input.owner_id ?? null,
      status: input.status,
      raised_at: input.raised_at ?? new Date().toISOString().slice(0, 10), // NOT NULL date — default to today
      due_date: input.due_date ?? null,
      // content-enrichment (0008): every field the schema accepts is saved
      probability_pct: input.probability_pct ?? null,
      impact_score: input.impact_score ?? null,
      response_strategy: input.response_strategy,
      risk_category: input.risk_category ?? null,
      impact_area: input.impact_area ?? null,
      trigger: input.trigger ?? null,
      residual_risk: input.residual_risk ?? null,
      // ── complement seam (0041, R-81) ─────────────────────────────────────────
      source: input.source ?? null,
      external_ref: input.external_ref ?? null,
      external_url: input.external_url ?? null,
    })
    .select()
    .single();

  if (error || !row) throw new Error(error?.message ?? "Insert failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "risk.create",
    targetType: "risk",
    targetId: row.id,
    before: null,
    after: row,
  });

  // Notify project owner when severity is high or critical — fail-soft
  if (input.severity === "high" || input.severity === "critical") {
    void resolveProjectOwner(actor.workspaceId, projectId).then((ownerId) => {
      if (!ownerId) return;
      return notify({
        workspaceId: actor.workspaceId,
        recipientIds: [ownerId],
        type: "risk.escalated",
        title: `${input.severity.toUpperCase()} risk raised: ${input.title}`,
        body: input.description ?? undefined,
        payload: { riskId: row.id, projectId, severity: input.severity, refId: row.reference_id },
      });
    });
  }

  return created(row);
});

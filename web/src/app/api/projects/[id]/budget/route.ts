import { route } from "@/lib/api/handler";
import { requireScope, type Actor } from "@/lib/auth/guard";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { upsertBudgetSchema } from "@/app/api/budget/_schema";

export const runtime = "nodejs";

async function assertProjectInWorkspace(
  db: ReturnType<typeof createAdminClient>,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const { data } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data) throw new NotFoundError("Project not found");
}

export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "budget:read");
  const db = createAdminClient();
  const projectId = params.id;

  await assertProjectInWorkspace(db, projectId, actor.workspaceId);

  const { data: budget } = await db
    .from("project_budget")
    .select("*")
    .eq("project_id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  // Actual = expenses only (hour logging was removed; time_entries is no longer read)
  const expenseResult = await db
    .from("expenses")
    .select("amount")
    .eq("project_id", projectId)
    .eq("workspace_id", actor.workspaceId);

  const expenseTotal = (expenseResult.data ?? []).reduce(
    (sum: number, row: { amount: number | null }) => sum + (row.amount ?? 0),
    0,
  );
  const actual = expenseTotal;

  const planned = budget?.planned_amount ?? 0;
  const variance = planned - actual;
  const burn_pct = planned > 0 ? (actual / planned) * 100 : 0;

  return ok({
    ...(budget ?? {
      project_id: projectId,
      workspace_id: actor.workspaceId,
      planned_amount: 0,
      committed_amount: 0,
      currency: "USD",
    }),
    actual,
    variance,
    burn_pct,
  });
});

/** Every writable column of project_budget, in the order the schema declares them. */
const BUDGET_FIELDS = [
  "planned_amount",
  "committed_amount",
  "currency",
  "actual_amount",
  "contingency_reserve",
  "management_reserve",
] as const;

type BudgetPayload = Partial<Record<(typeof BUDGET_FIELDS)[number], number | string>>;

/**
 * Upsert the given columns onto the project's budget row and audit it. Only the
 * columns in `fields` are written: on an existing row an upsert leaves the
 * omitted ones as they are, and a first write gets the DB defaults for them.
 */
async function saveBudget(
  db: ReturnType<typeof createAdminClient>,
  actor: Actor,
  projectId: string,
  fields: BudgetPayload,
) {
  // Fetch existing for before snapshot
  const { data: existing } = await db
    .from("project_budget")
    .select("*")
    .eq("project_id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  const { data: upserted, error } = await db
    .from("project_budget")
    .upsert(
      { project_id: projectId, workspace_id: actor.workspaceId, ...fields },
      { onConflict: "project_id" },
    )
    .select()
    .single();

  if (error || !upserted) {
    throw new Error(`Budget upsert failed: ${error?.message ?? "no row returned"}`);
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "budget.update",
    targetType: "project_budget",
    targetId: projectId,
    before: existing ?? null,
    after: upserted,
  });

  return upserted;
}

// PUT /api/projects/[id]/budget — set the budget. planned_amount is required;
// committed_amount and currency fall back to 0 / USD when omitted (a PUT states
// the whole budget). The three PMBOK columns (actual_amount, contingency_reserve,
// management_reserve) are persisted when sent and left alone when not.
export const PUT = route(async ({ actor, params, request }) => {
  requireScope(actor, "budget:write");
  const db = createAdminClient();
  const projectId = params.id;

  await assertProjectInWorkspace(db, projectId, actor.workspaceId);

  const body = await safeJson(request);
  const parsed = upsertBudgetSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const fields: BudgetPayload = {};
  for (const field of BUDGET_FIELDS) {
    const value = parsed.data[field];
    if (value !== undefined) fields[field] = value;
  }

  return ok(await saveBudget(db, actor, projectId, fields));
});

// PATCH /api/projects/[id]/budget — partial update: ONLY the columns named in the
// body are written. Nothing is defaulted — omitting committed_amount or currency
// leaves the stored values alone — and an empty body is a 422.
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "budget:write");
  const db = createAdminClient();
  const projectId = params.id;

  await assertProjectInWorkspace(db, projectId, actor.workspaceId);

  const body = await safeJson(request);
  const raw: Record<string, unknown> =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  // Same per-column rules as PUT, with planned_amount optional. The parsed
  // object may carry zod defaults, so the payload is built from the keys the
  // caller actually sent — never from the parse result's own key set.
  const parsed = upsertBudgetSchema.partial().safeParse(raw);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const fields: BudgetPayload = {};
  for (const field of BUDGET_FIELDS) {
    const value = parsed.data[field];
    if (Object.prototype.hasOwnProperty.call(raw, field) && value !== undefined) fields[field] = value;
  }
  if (Object.keys(fields).length === 0) {
    return validationError("Validation failed", [
      { field: "body", message: `send at least one of: ${BUDGET_FIELDS.join(", ")}` },
    ]);
  }

  return ok(await saveBudget(db, actor, projectId, fields));
});

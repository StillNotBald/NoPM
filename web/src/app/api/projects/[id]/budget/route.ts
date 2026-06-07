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

  // Compute actuals from time_entries and expenses
  const [timeResult, expenseResult] = await Promise.all([
    db
      .from("time_entries")
      .select("cost")
      .eq("project_id", projectId)
      .eq("workspace_id", actor.workspaceId),
    db
      .from("expenses")
      .select("amount")
      .eq("project_id", projectId)
      .eq("workspace_id", actor.workspaceId),
  ]);

  const timeCost = (timeResult.data ?? []).reduce(
    (sum: number, row: { cost: number | null }) => sum + (row.cost ?? 0),
    0,
  );
  const expenseTotal = (expenseResult.data ?? []).reduce(
    (sum: number, row: { amount: number | null }) => sum + (row.amount ?? 0),
    0,
  );
  const actual = timeCost + expenseTotal;

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

  // Fetch existing for before snapshot
  const { data: existing } = await db
    .from("project_budget")
    .select("*")
    .eq("project_id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  const payload = {
    project_id: projectId,
    workspace_id: actor.workspaceId,
    planned_amount: parsed.data.planned_amount,
    committed_amount: parsed.data.committed_amount,
    currency: parsed.data.currency,
  };

  const { data: upserted, error } = await db
    .from("project_budget")
    .upsert(payload, { onConflict: "project_id" })
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

  return ok(upserted);
});

export const PATCH = PUT;

import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeEvm } from "@/lib/evm";
import { workspaceToday } from "@/lib/integrations/time-zone";

export const runtime = "nodejs";

/**
 * GET /api/projects/:id/evm — the earned-value numbers for one project, computed
 * exactly as the Budget page computes them (BAC from the budget, AC = sum of
 * expenses, EV from project completion, PV from the baseline dates when the
 * project has them). Read-only, derived: nothing is stored or audited.
 */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "budget:read");
  const db = createAdminClient();
  const projectId = params.id;

  const { data: project } = await db
    .from("projects")
    .select("id, completion_pct, baseline_start_date, baseline_target_date, currency")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (!project) throw new NotFoundError("Project not found");

  const { data: budget, error: budgetError } = await db
    .from("project_budget")
    .select("planned_amount, committed_amount, currency, estimate_to_complete, forecast_method, committed_open")
    .eq("project_id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  // A failed read must never look like "no budget": on a database without 0097 the new columns
  // make this read fail, and zeros would read as a project with no spend.
  if (budgetError) throw new Error(`evm: budget read failed: ${budgetError.message}`);

  const { data: expenses, error: expenseError } = await db
    .from("expenses")
    .select("amount")
    .eq("project_id", projectId)
    .eq("workspace_id", actor.workspaceId);
  if (expenseError) throw new Error(`evm: expenses read failed: ${expenseError.message}`);
  const actual = (expenses ?? []).reduce((sum: number, row: { amount: number | null }) => sum + (row.amount ?? 0), 0);

  const asOf = await workspaceToday(actor.workspaceId);
  const evm = computeEvm({
    planned_amount: Number(budget?.planned_amount ?? 0),
    completion_pct: Number(project.completion_pct ?? 0),
    committed_amount: Number(budget?.committed_amount ?? 0),
    actual_amount: actual,
    baseline_start_date: project.baseline_start_date,
    baseline_target_date: project.baseline_target_date,
    as_of_date: asOf,
    // B3: the bottom-up forecast needs the manual to-finish estimate and the chosen method.
    estimate_to_complete: budget?.estimate_to_complete == null ? null : Number(budget.estimate_to_complete),
    committed_open: budget?.committed_open == null ? null : Number(budget.committed_open),
    forecast_method: budget?.forecast_method === "bottom_up" ? "bottom_up" : "cpi",
  });

  return ok({
    project_id: projectId,
    currency: budget?.currency ?? project.currency ?? "USD",
    as_of_date: asOf,
    schedule_basis: project.baseline_start_date && project.baseline_target_date ? "baseline_dates" : "completion_only",
    ...evm,
  });
});

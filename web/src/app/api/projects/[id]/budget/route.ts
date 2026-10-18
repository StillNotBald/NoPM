import { route } from "@/lib/api/handler";
import { requireScope, type Actor } from "@/lib/auth/guard";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { upsertBudgetSchema } from "@/app/api/budget/_schema";
import { DEFAULT_WARN_PCT, OVERSPEND_AUDIT_ACTION, recordOverspendCrossing } from "@/lib/insight/overspend";

export const runtime = "nodejs";

async function assertProjectInWorkspace(
  db: ReturnType<typeof createAdminClient>,
  projectId: string,
  workspaceId: string,
): Promise<{ is_locked: boolean }> {
  const { data } = await db
    .from("projects")
    .select("id, is_locked")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data) throw new NotFoundError("Project not found");
  return { is_locked: data.is_locked === true };
}

const LOCKED_BUDGET_MESSAGE =
  "This project's dates are locked. Changing its budget needs an approved change request: send its id as change_request_id.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decision 23 (Q-WRK-12/13): once a project's dates are locked, a budget change
 * must reference an APPROVED, cost-related change request of THIS project that no
 * earlier budget change has used. The request is consumed here (compare-and-set on
 * budget_consumed_at, so two concurrent changes cannot share one request) and
 * released again if the budget write fails. Returns its id (recorded in the audit row).
 */
async function consumeApprovedChangeRequest(
  db: ReturnType<typeof createAdminClient>,
  actor: Actor,
  projectId: string,
  body: unknown,
): Promise<string> {
  const id =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).change_request_id
      : undefined;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new RuleError(LOCKED_BUDGET_MESSAGE, "change_request_required");
  }
  const { data: cr } = await db
    .from("change_requests")
    .select("id, status, project_id, category, impact_cost, budget_consumed_at")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (!cr || cr.project_id !== projectId) {
    throw new RuleError("That change request does not belong to this project.", "change_request_invalid");
  }
  if (cr.status !== "approved" && cr.status !== "implemented") {
    throw new RuleError(
      "That change request is not approved yet. Budget changes on a locked project need an approved change request.",
      "change_request_not_approved",
    );
  }
  if (cr.category !== "cost" && cr.impact_cost == null) {
    throw new RuleError(
      "That change request does not cover a cost change. Raise a cost change request for the budget.",
      "change_request_not_cost",
    );
  }
  const { data: claimed } = await db
    .from("change_requests")
    .update({ budget_consumed_at: new Date().toISOString(), budget_consumed_by: projectId })
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .is("budget_consumed_at", null)
    .select("id");
  if (!claimed || claimed.length === 0) {
    throw new RuleError(
      "That change request has already been used for a budget change. Raise a new one.",
      "change_request_used",
    );
  }
  return cr.id as string;
}

async function releaseChangeRequest(
  db: ReturnType<typeof createAdminClient>,
  actor: Actor,
  changeRequestId: string,
): Promise<void> {
  await db
    .from("change_requests")
    .update({ budget_consumed_at: null, budget_consumed_by: null })
    .eq("id", changeRequestId)
    .eq("workspace_id", actor.workspaceId);
}

/** Changing only the warning threshold is advisory, not a money change: no change request needed. */
function needsChangeRequest(fields: BudgetPayload): boolean {
  return Object.keys(fields).some((k) => k !== "overspend_warn_pct");
}

/** Gate (locked projects), save, and give the change request back if the save fails. */
async function gatedSave(
  db: ReturnType<typeof createAdminClient>,
  actor: Actor,
  projectId: string,
  fields: BudgetPayload,
  locked: boolean,
  body: unknown,
) {
  const crId = locked && needsChangeRequest(fields) ? await consumeApprovedChangeRequest(db, actor, projectId, body) : null;
  try {
    return await saveBudget(db, actor, projectId, fields, crId);
  } catch (e) {
    if (crId) await releaseChangeRequest(db, actor, crId).catch(() => undefined);
    throw e;
  }
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

  const warnPct: number = budget?.overspend_warn_pct ?? DEFAULT_WARN_PCT;
  const { data: events } = await db
    .from("audit_log")
    .select("created_at, actor_label, before, after")
    .eq("workspace_id", actor.workspaceId)
    .eq("action", OVERSPEND_AUDIT_ACTION)
    .eq("target_id", projectId)
    .order("created_at", { ascending: false })
    .limit(10);

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
    // Decision 19: advisory only, never blocks. One event per threshold crossing.
    overspend: {
      level: budget?.overspend_level ?? "ok",
      warn_pct: warnPct,
      over_pct: 100,
      events: events ?? [],
    },
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
  "overspend_warn_pct",
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
  changeRequestId: string | null = null,
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
    after: changeRequestId ? { ...upserted, change_request_id: changeRequestId } : upserted,
  });

  // Decision 19: a plan change can move the same spend across a threshold.
  await recordOverspendCrossing(db, actor, projectId);

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

  const project = await assertProjectInWorkspace(db, projectId, actor.workspaceId);

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

  return ok(await gatedSave(db, actor, projectId, fields, project.is_locked, body));
});

// PATCH /api/projects/[id]/budget — partial update: ONLY the columns named in the
// body are written. Nothing is defaulted — omitting committed_amount or currency
// leaves the stored values alone — and an empty body is a 422.
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "budget:write");
  const db = createAdminClient();
  const projectId = params.id;

  const project = await assertProjectInWorkspace(db, projectId, actor.workspaceId);

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

  return ok(await gatedSave(db, actor, projectId, fields, project.is_locked, body));
});

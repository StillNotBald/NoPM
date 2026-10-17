import { z } from "zod";
import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { okList, created, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { hashRequestBody, readIdempotencyKey, withIdempotency } from "@/lib/api/idempotency";

export const runtime = "nodejs";

const createExpenseSchema = z.object({
  description: z.string().min(1).max(500),
  amount: z.number().nonnegative("amount must be >= 0"),
  category: z.string().max(100).optional().nullable(),
  incurred_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "incurred_on must be YYYY-MM-DD")
    .optional()
    .nullable(),
});

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

export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "budget:read");
  const db = createAdminClient();
  const projectId = params.id;

  await assertProjectInWorkspace(db, projectId, actor.workspaceId);

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  const { data: items, count, error } = await db
    .from("expenses")
    .select("*", { count: "exact" })
    .eq("project_id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .order("incurred_on", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Expenses query failed: ${error.message}`);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "budget:write");
  const db = createAdminClient();
  const projectId = params.id;

  await assertProjectInWorkspace(db, projectId, actor.workspaceId);

  const body = await safeJson(request);
  const parsed = createExpenseSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  // D-WRK-12: a retry with the same Idempotency-Key returns the first expense.
  const idem = await withIdempotency(
    {
      workspaceId: actor.workspaceId,
      actorId: actor.id,
      key: readIdempotencyKey(request),
      route: `POST /api/projects/${projectId}/expenses`,
      bodyHash: hashRequestBody(parsed.data),
    },
    async () => {
  const { data: row, error } = await db
    .from("expenses")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: projectId,
      description: parsed.data.description,
      amount: parsed.data.amount,
      category: parsed.data.category ?? null,
      // incurred_on is NOT NULL with a DB default of today: omit the key when not sent (never an explicit NULL).
      ...(parsed.data.incurred_on ? { incurred_on: parsed.data.incurred_on } : {}),
    })
    .select()
    .single();

  if (error || !row) {
    throw new Error(`Expense insert failed: ${error?.message ?? "no row returned"}`);
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "expense.create",
    targetType: "expense",
    targetId: row.id,
    before: null,
    after: row,
  });

  return row;
    },
  );

  return created(idem.result);
});

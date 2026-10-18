import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { noContent } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";

export const runtime = "nodejs";

export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "budget:write");
  const db = createAdminClient();
  const expenseId = params.id;

  const { data: existing } = await db
    .from("expenses")
    .select("*")
    .eq("id", expenseId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!existing) throw new NotFoundError("Expense not found");

  const { error } = await db
    .from("expenses")
    .delete()
    .eq("id", expenseId)
    .eq("workspace_id", actor.workspaceId);

  if (error) throw new Error(`Expense delete failed: ${error.message}`);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "expense.delete",
    targetType: "expense",
    targetId: expenseId,
    before: existing,
    after: null,
  });

  return noContent();
});

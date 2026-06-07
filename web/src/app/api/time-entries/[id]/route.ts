import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { noContent } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";

export const runtime = "nodejs";

export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "time:write");
  const db = createAdminClient();
  const entryId = params.id;

  const { data: existing } = await db
    .from("time_entries")
    .select("*")
    .eq("id", entryId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!existing) throw new NotFoundError("Time entry not found");

  const { error } = await db
    .from("time_entries")
    .delete()
    .eq("id", entryId)
    .eq("workspace_id", actor.workspaceId);

  if (error) throw new Error(`Time entry delete failed: ${error.message}`);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "time.delete",
    targetType: "time_entry",
    targetId: entryId,
    before: existing,
    after: null,
  });

  return noContent();
});

import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { noContent } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { assertWeekUnlocked, weekLockRuleError } from "@/lib/governance/period-lock";

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

  // L-32/R-76 + R1/H2: reject deleting from a week whose timesheet is approved
  // (period_locked) or submitted and awaiting a decision (timesheet_locked) —
  // clean 422 before the DB backstop trigger would otherwise raise a 500-shaped
  // error (migrations 20260815000040 / 20261017000049).
  await assertWeekUnlocked(db, existing.member_id, existing.entry_date);

  const { error } = await db
    .from("time_entries")
    .delete()
    .eq("id", entryId)
    .eq("workspace_id", actor.workspaceId);

  if (error) {
    const locked = weekLockRuleError(error);
    if (locked) throw locked;
    throw new Error(`Time entry delete failed: ${error.message}`);
  }

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

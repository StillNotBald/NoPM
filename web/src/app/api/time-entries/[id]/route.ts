import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { noContent } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { assertWeekUnlocked, isPeriodLockedError } from "@/lib/governance/period-lock";

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

  // L-32/R-76: reject deleting from a week whose timesheet is already
  // approved (locked) — clean 422 before the DB backstop trigger would
  // otherwise raise a 500-shaped PERIOD_LOCKED error (migration 20260815000040).
  await assertWeekUnlocked(db, existing.member_id, existing.entry_date);

  const { error } = await db
    .from("time_entries")
    .delete()
    .eq("id", entryId)
    .eq("workspace_id", actor.workspaceId);

  if (error) {
    if (isPeriodLockedError(error)) {
      throw new RuleError(
        "This week's timesheet is approved and locked — reopen the submission before changing time entries.",
        "period_locked",
      );
    }
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

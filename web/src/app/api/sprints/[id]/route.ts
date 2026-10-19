import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate } from "@/lib/audit/audited-write";
import { requestDeletion } from "@/lib/governance/request-deletion";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { updateSprintSchema } from "../_schema";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { withTimingFlag } from "@/lib/sprints/flags";

export const runtime = "nodejs";

// GET /api/sprints/[id] — fetch a single sprint (sprint:read)
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "sprint:read");

  const db = createAdminClient();
  const { data, error } = await db
    .from("sprints")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("Sprint not found");

  return ok(withTimingFlag(data));
});

/**
 * PATCH /api/sprints/[id] — partial update of name/goal/dates ONLY
 * (sprint:write). `state` is never settable here — see POST /start and
 * POST /close. A closed sprint rejects every PATCH (dates immutable once
 * closed, per the owner-locked decision — and since closed is terminal,
 * name/goal are frozen alongside the dates rather than carving out a
 * partial exception).
 */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "sprint:write");

  const db = createAdminClient();

  const { data: before, error: fetchError } = await db
    .from("sprints")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("Sprint not found");

  if (before.state === "closed") {
    throw new RuleError("Closed sprints cannot be edited");
  }

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, updateSprintSchema);
  if (unknown) return unknown;
  const parsed = updateSprintSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid sprint data",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const nextStart = parsed.data.start_date ?? before.start_date;
  const nextEnd = parsed.data.end_date ?? before.end_date;
  if (nextEnd < nextStart) {
    return validationError("Invalid sprint dates", [
      { field: "end_date", message: "end_date must be on or after start_date" },
    ]);
  }

  const now = new Date().toISOString();
  // Row and audit row are one transaction (nopm_mutate_audited).
  const { after } = await auditedUpdate({
    table: "sprints",
    actor,
    action: "sprint.update",
    id: params.id,
    patch: { ...parsed.data, updated_at: now },
    notFoundMessage: "Sprint not found",
  });

  return ok(after);
});

/**
 * DELETE /api/sprints/[id] — does NOT delete the sprint. It raises a deletion request (scope sprint:write, as the
 * direct delete had) with a required `reason` and returns 202 with the deletion_requests row. Only a planned sprint
 * with no attached tasks can be asked for (422 otherwise, as before). A second person approves it at
 * POST /api/deletion-requests/:id/approve (R-176).
 */
export const DELETE = route(async ({ actor, params, request }) =>
  requestDeletion({ actor, request, entity: "sprint", id: params.id }),
);

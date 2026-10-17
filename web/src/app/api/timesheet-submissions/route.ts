import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import {
  assertHasEntriesToSubmit,
  assertNoOpenDuplicate,
  summariseEntries,
  TIMESHEET_ENTRY_COLUMNS,
  timesheetContentDigest,
  type TimesheetEntryRow,
} from "@/lib/governance/timesheet-decision";
import { announceRequested, requireMakerPrincipal, timesheetEvent } from "@/lib/governance/decide";
import { createTimesheetSubmissionSchema, TIMESHEET_STATUSES } from "./_schema";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/timesheet-submissions — list submissions in the actor's workspace
 * (time:read). Filters: member_id, status, period (= period_start exact
 * match). Ordered submitted_at desc.
 */
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "time:read");

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10) || 20));
  const offset = (page - 1) * limit;

  const memberId = searchParams.get("member_id");
  if (memberId && !UUID_RE.test(memberId)) {
    return validationError("Invalid member_id filter", [
      { field: "member_id", message: "must be a UUID" },
    ]);
  }

  const status = searchParams.get("status");
  if (status && !(TIMESHEET_STATUSES as readonly string[]).includes(status)) {
    return validationError("Invalid status filter", [
      { field: "status", message: `must be one of ${TIMESHEET_STATUSES.join(", ")}` },
    ]);
  }

  const period = searchParams.get("period");
  if (period && !/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    return validationError("Invalid period filter", [
      { field: "period", message: "must be an ISO date (YYYY-MM-DD)" },
    ]);
  }

  const db = createAdminClient();

  // Inlined filters (not a generic helper applied to the builder) — the
  // house TS2589 workaround used by every other register list route.
  let countQuery = db
    .from("timesheet_submissions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId);
  if (memberId) countQuery = countQuery.eq("member_id", memberId);
  if (status) countQuery = countQuery.eq("status", status);
  if (period) countQuery = countQuery.eq("period_start", period);
  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  let query = db
    .from("timesheet_submissions")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .order("submitted_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (memberId) query = query.eq("member_id", memberId);
  if (status) query = query.eq("status", status);
  if (period) query = query.eq("period_start", period);

  const { data, error } = await query;
  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

/**
 * POST /api/timesheet-submissions — submit a weekly timesheet for a member
 * (time:submit). Snapshots hours_total/entry_count — and a content digest of
 * the entries — from time_entries in [period_start, period_start + 6] at
 * submit time (never recomputed afterwards — mirrors the sprint snapshot
 * precedent, migration 0037). The approval step is bound to that snapshot
 * (422 `timesheet_changed` if the entries no longer match) and the week's
 * entries are frozen while the sheet is under review (R1/H2).
 *
 * A token with no recorded owner can't submit (403 `no_principal`): the
 * submitter's human is what four-eyes compares the approver against (R1/H3).
 */
export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "time:submit");
  const submitterPrincipal = requireMakerPrincipal(actor);

  const body = await safeJson(request);
  const parsed = createTimesheetSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid timesheet submission data",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const db = createAdminClient();

  // Verify the member exists and belongs to this workspace.
  const { data: member } = await db
    .from("resource_members")
    .select("id, name")
    .eq("id", parsed.data.member_id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (!member) throw new NotFoundError("Resource member not found");

  const periodStart = parsed.data.period_start;
  const periodEnd = addDaysIso(periodStart, 6);

  // Clean 422 pre-check (DB uniq_open_timesheet index is the backstop).
  const { data: existing } = await db
    .from("timesheet_submissions")
    .select("id, status")
    .eq("member_id", parsed.data.member_id)
    .eq("period_start", periodStart)
    .in("status", ["submitted", "approved"])
    .maybeSingle();
  assertNoOpenDuplicate(existing);

  // Snapshot hours_total + entry_count from time_entries in the period.
  const { data: entries, error: entriesError } = await db
    .from("time_entries")
    .select(TIMESHEET_ENTRY_COLUMNS)
    .eq("member_id", parsed.data.member_id)
    .eq("workspace_id", actor.workspaceId)
    .gte("entry_date", periodStart)
    .lte("entry_date", periodEnd);
  if (entriesError) throw entriesError;

  const rows = (entries ?? []) as TimesheetEntryRow[];
  assertHasEntriesToSubmit(rows.length);

  const { hoursTotal } = summariseEntries(rows);
  const contentDigest = timesheetContentDigest(rows);

  const { data: row, error } = await db
    .from("timesheet_submissions")
    .insert({
      workspace_id: actor.workspaceId,
      member_id: parsed.data.member_id,
      period_start: periodStart,
      period_end: periodEnd,
      hours_total: hoursTotal,
      entry_count: rows.length,
      content_digest: contentDigest,
      status: "submitted",
      submitted_by: actor.id,
      submitted_by_type: actor.type,
      submitted_by_label: actor.label,
      // The HUMAN behind the submitter (the user, or the token's creator) —
      // four-eyes compares this, not the actor id.
      submitted_principal_id: submitterPrincipal,
    })
    .select()
    .single();

  if (error) throw error;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "timesheet.submitted",
    targetType: "timesheet_submission",
    targetId: row.id,
    before: null,
    after: row,
  });

  // Fan-out to workspace approvers — fail-soft, never blocks the submission.
  void resolveWorkspaceApprovers(actor.workspaceId).then((ids) =>
    notify({
      workspaceId: actor.workspaceId,
      recipientIds: ids,
      type: "approval.requested",
      title: `Timesheet submitted — ${member.name}, week of ${periodStart}`,
      body: `${hoursTotal} hours across ${rows.length} entr${rows.length === 1 ? "y" : "ies"}.`,
      payload: { timesheetSubmissionId: row.id, href: "/timesheets" },
    }),
  );

  // Tell the integration hub (chat approval cards) — never throws, runs after
  // the submission and its audit row are committed.
  announceRequested(await timesheetEvent(db, actor.workspaceId, row, member.name));

  return created(row);
});

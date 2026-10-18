import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { fail, ok } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { getWorkspaceTimeZone, todayInZone } from "@/lib/integrations/time-zone";
import { generateWeeklyReport, loadWeeklySnapshot, parseWeekParam, weekStartOfDay } from "@/lib/nudges/weekly-report";
import { renderWeeklyReportHtml } from "@/lib/reports/weekly-html";

export const runtime = "nodejs";

/**
 * GET /api/reports/weekly?week=<iso>  (scope `report:read`)
 *
 * The stored weekly status report for one ISO week as an HTML page (R-142).
 * `week` is any calendar day (2026-10-14) or an ISO week (2026-W42); omitted =
 * the current week in the workspace time zone. Workspace-filtered. 404 when no
 * report was generated for that week, 422 for an unreadable `week`.
 * The page shows what was generated at the time, not today's figures.
 */
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "report:read");

  const raw = new URL(request.url).searchParams.get("week");
  let weekStart: string | null;
  if (raw) {
    weekStart = parseWeekParam(raw);
    if (!weekStart) return fail("week must be a date (YYYY-MM-DD) or an ISO week (YYYY-Www)", 422);
  } else {
    weekStart = weekStartOfDay(todayInZone(await getWorkspaceTimeZone(actor.workspaceId)));
  }

  const snap = await loadWeeklySnapshot(actor.workspaceId, weekStart);
  if (!snap) return fail(`No weekly report was generated for the week of ${weekStart}`, 404);

  return new Response(renderWeeklyReportHtml(snap), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A report carries workspace figures: never cached by a shared proxy.
      "cache-control": "private, no-store",
    },
  });
});

/**
 * POST /api/reports/weekly — "Send weekly report now" (admin or manager session).
 *
 * Builds the current week's report, notifies every admin and manager in the
 * workspace (in-app bell + the email demo-preview; nothing is emailed) and
 * writes one `report.weekly.generated` audit row. It never takes the scheduled
 * run's slot, so pressing it does not stop the next scheduled report.
 */
export const POST = route(async ({ actor }) => {
  if (actor.type !== "user" || (actor.role !== "admin" && actor.role !== "manager")) {
    throw new ScopeError("Sending the weekly report requires an admin or manager session");
  }
  const result = await generateWeeklyReport(actor.workspaceId, { trigger: "manual", actor });
  if (result.status === "generated") {
    return ok({ week_start: result.weekStart, recipients: result.recipients, report_url: `/api/reports/weekly?week=${result.weekStart}` });
  }
  if (result.status === "no_recipients") return fail("This workspace has no admin or manager to send the report to", 422);
  return fail("The weekly report could not be generated; nothing was sent. Try again.", 500);
});

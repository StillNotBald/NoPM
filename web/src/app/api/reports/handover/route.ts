import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { toCsv } from "@/lib/export/csv";
import { workspaceToday } from "@/lib/integrations/time-zone";
import {
  HANDOVER_CSV_COLUMNS, gatherHandover, handoverCsvRows, type HandoverDb,
} from "@/lib/handover/report";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/reports/handover[?project_id=<uuid>][&format=json|csv] - handover /
 * key-person report (M6, R-140): the open items whose single owner has no backup,
 * per project and grouped by owner, plus a key-person matrix with a bus_factor_1
 * flag. Read-only and derived; workspace-filtered. Needs the `report:read` scope (the same
 * one as the weekly report); the report is read-only and always workspace-filtered. `format=csv` returns the same data
 * as one CSV and is audited like every export (`export.csv`, entity `handover`).
 */
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "report:read");

  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") throw new RuleError('format must be "json" or "csv"');

  const rawProject = url.searchParams.get("project_id");
  const projectId = rawProject && rawProject.trim() !== "" ? rawProject.trim() : null;
  if (projectId !== null && !UUID_RE.test(projectId)) throw new RuleError("project_id must be a valid UUID");

  const db = createAdminClient();
  if (projectId !== null) {
    const { data: project } = await db
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (!project) throw new NotFoundError("Project not found");
  }

  const report = await gatherHandover(db as unknown as HandoverDb, actor.workspaceId, projectId);
  if (format === "json") return ok(report);

  const rows = handoverCsvRows(report);
  const csv = toCsv([...HANDOVER_CSV_COLUMNS], rows);
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "export.csv",
    targetType: "entity",
    targetId: null,
    before: null,
    after: { entity: "handover", row_count: rows.length, filters: { project_id: projectId } },
  });

  const today = await workspaceToday(actor.workspaceId);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="nopm-handover-${today}.csv"`,
    },
  });
});

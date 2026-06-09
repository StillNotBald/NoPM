import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { entityHref } from "@/lib/nav/entity-href";

export const runtime = "nodejs";

/**
 * GET /api/search?q=<query>
 *
 * Full-workspace record search for the authenticated session user.
 * Searches across: projects, tasks, risks, issues, clashes, documents,
 * change_requests, and decisions — case-insensitive ilike, capped ~6 per
 * type, ~30 total.
 *
 * Response: { data: SearchResult[] }
 */

export type SearchResult = {
  type:
    | "project"
    | "task"
    | "risk"
    | "issue"
    | "clash"
    | "document"
    | "change_request"
    | "decision";
  id: string;
  label: string;
  sublabel?: string;
  href: string;
  reference_id?: string;
};

const PER_TYPE = 6;

export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "project:read");

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();

  // Require at least 1 char to avoid full-table scans
  if (!q) {
    return ok<SearchResult[]>([]);
  }

  const pattern = `%${q}%`;
  const db = createAdminClient();
  const ws = actor.workspaceId;

  // Run all queries in parallel
  const [
    projectsRes,
    tasksRes,
    risksRes,
    issuesRes,
    clashesRes,
    documentsRes,
    changeRequestsRes,
    decisionsRes,
  ] = await Promise.all([
    // projects: name OR code
    db
      .from("projects")
      .select("id, name, code, status")
      .eq("workspace_id", ws)
      .or(`name.ilike.${pattern},code.ilike.${pattern}`)
      .limit(PER_TYPE),

    // tasks: name
    db
      .from("tasks")
      .select("id, name, project_id, status_type")
      .eq("workspace_id", ws)
      .ilike("name", pattern)
      .limit(PER_TYPE),

    // risks: title
    db
      .from("risks")
      .select("id, title, status, project_id")
      .eq("workspace_id", ws)
      .ilike("title", pattern)
      .limit(PER_TYPE),

    // issues: title
    db
      .from("issues")
      .select("id, title, status, project_id")
      .eq("workspace_id", ws)
      .ilike("title", pattern)
      .limit(PER_TYPE),

    // clashes: title
    db
      .from("clashes")
      .select("id, title, status, reference_id")
      .eq("workspace_id", ws)
      .ilike("title", pattern)
      .limit(PER_TYPE),

    // documents: title OR reference_id
    db
      .from("documents")
      .select("id, title, reference_id, doc_type, status")
      .eq("workspace_id", ws)
      .or(`title.ilike.${pattern},reference_id.ilike.${pattern}`)
      .limit(PER_TYPE),

    // change_requests: title OR reference_id
    db
      .from("change_requests")
      .select("id, title, reference_id, status")
      .eq("workspace_id", ws)
      .or(`title.ilike.${pattern},reference_id.ilike.${pattern}`)
      .limit(PER_TYPE),

    // decisions: title OR reference_id
    db
      .from("decisions")
      .select("id, title, reference_id, status")
      .eq("workspace_id", ws)
      .or(`title.ilike.${pattern},reference_id.ilike.${pattern}`)
      .limit(PER_TYPE),
  ]);

  const results: SearchResult[] = [];

  // Projects
  for (const row of projectsRes.data ?? []) {
    results.push({
      type: "project",
      id: row.id as string,
      label: row.name as string,
      sublabel: row.code ? `${row.code} · ${row.status ?? ""}` : (row.status as string | undefined) ?? undefined,
      href: entityHref("project", { id: row.id as string }),
    });
  }

  // Tasks
  for (const row of tasksRes.data ?? []) {
    results.push({
      type: "task",
      id: row.id as string,
      label: row.name as string,
      sublabel: (row.status_type as string | undefined) ?? undefined,
      href: entityHref("task", { id: row.id as string, projectId: row.project_id as string }),
    });
  }

  // Risks
  for (const row of risksRes.data ?? []) {
    results.push({
      type: "risk",
      id: row.id as string,
      label: row.title as string,
      sublabel: (row.status as string | undefined) ?? undefined,
      href: entityHref("risk", { id: row.id as string }),
    });
  }

  // Issues
  for (const row of issuesRes.data ?? []) {
    results.push({
      type: "issue",
      id: row.id as string,
      label: row.title as string,
      sublabel: (row.status as string | undefined) ?? undefined,
      href: entityHref("issue", { id: row.id as string }),
    });
  }

  // Clashes
  for (const row of clashesRes.data ?? []) {
    results.push({
      type: "clash",
      id: row.id as string,
      label: row.title as string,
      sublabel: (row.reference_id as string | undefined) ?? (row.status as string | undefined) ?? undefined,
      href: entityHref("clash", { id: row.id as string }),
      reference_id: (row.reference_id as string | undefined) ?? undefined,
    });
  }

  // Documents
  for (const row of documentsRes.data ?? []) {
    results.push({
      type: "document",
      id: row.id as string,
      label: row.title as string,
      sublabel: [row.reference_id, row.doc_type].filter(Boolean).join(" · ") || undefined,
      href: entityHref("document", { id: row.id as string }),
      reference_id: (row.reference_id as string | undefined) ?? undefined,
    });
  }

  // Change requests
  for (const row of changeRequestsRes.data ?? []) {
    results.push({
      type: "change_request",
      id: row.id as string,
      label: row.title as string,
      sublabel: [row.reference_id, row.status].filter(Boolean).join(" · ") || undefined,
      href: entityHref("change_request", { id: row.id as string }),
      reference_id: (row.reference_id as string | undefined) ?? undefined,
    });
  }

  // Decisions
  for (const row of decisionsRes.data ?? []) {
    results.push({
      type: "decision",
      id: row.id as string,
      label: row.title as string,
      sublabel: [row.reference_id, row.status].filter(Boolean).join(" · ") || undefined,
      href: entityHref("decision", { id: row.id as string }),
      reference_id: (row.reference_id as string | undefined) ?? undefined,
    });
  }

  // Cap total at ~30
  return ok<SearchResult[]>(results.slice(0, 30));
});

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";
import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { IssueFocusOpener } from "@/components/registers/issue-focus-opener";
import { IssuesView, type IssueRow } from "./_issues-view";
import { parseIssuePageFilters } from "./_params";

export const metadata: Metadata = { title: "Issues" };

type SP = Record<string, string | string[] | undefined>;

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2, urgent: 3, critical: 3 };
const STATUS_RANK: Record<string, number> = { open: 0, in_progress: 1, resolved: 2, closed: 3 };
const SORT_FIELDS = new Set(["title", "priority", "severity", "status", "due_date"]);

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

export default async function IssuesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const dateDisplayPref = parseAppearancePrefs(
    (await cookies()).get(APPEARANCE_COOKIE_NAME)?.value,
  ).dateDisplay;

  // Whitelisted URL filters (written by the register toolbar). Values are bound
  // as parameters by PostgREST; `q` is stripped of LIKE/filter-syntax characters.
  // status/severity/priority/project_id are validated (enum whitelists + UUID,
  // see _params.ts); a malformed value is ignored rather than crashing the query.
  const { status, severity, priority, project_id: projectId } = parseIssuePageFilters(sp);
  const q = first(sp.q)?.replace(/[\\%_,()]/g, " ").trim();

  let issuesQuery = db
    .from("issues")
    .select(
      "id, reference_id, title, description, project_id, priority, status, due_date, resolution, raised_at, severity, issue_category, impact, resolution_eta, resolved_at",
    )
    .order("created_at", { ascending: false });
  if (status) issuesQuery = issuesQuery.eq("status", status);
  if (severity) issuesQuery = issuesQuery.eq("severity", severity);
  if (priority) issuesQuery = issuesQuery.eq("priority", priority);
  if (projectId) issuesQuery = issuesQuery.eq("project_id", projectId);
  if (q) issuesQuery = issuesQuery.ilike("title", `%${q}%`);

  const [{ data: issues, error: issuesError }, { data: projects, error: projectsError }, { data: viewerProfile }] =
    await Promise.all([
      issuesQuery,
      db.from("projects").select("id, name").order("name"),
      // caller's own role — see risks/page.tsx for the pattern (L-46).
      db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    ]);

  if (issuesError) return <QueryError what="issues" message={issuesError.message} />;
  if (projectsError) return <QueryError what="projects" message={projectsError.message} />;

  const canWrite = viewerProfile?.role !== "viewer";
  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  // Sort (default: newest first, from the query). Ranked fields sort by urgency, not alphabetically.
  let rows = (issues ?? []) as IssueRow[];
  const [sortField, sortDir] = (first(sp.sort) ?? "").split(":");
  if (SORT_FIELDS.has(sortField) && (sortDir === "asc" || sortDir === "desc")) {
    const dir = sortDir === "asc" ? 1 : -1;
    const key = (r: IssueRow): number | string => {
      if (sortField === "priority") return RANK[r.priority] ?? -1;
      if (sortField === "severity") return RANK[r.severity ?? ""] ?? -1;
      if (sortField === "status") return STATUS_RANK[r.status] ?? 99;
      if (sortField === "due_date") return r.due_date ?? "";
      return r.title.toLowerCase();
    };
    rows = [...rows].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      // empty due dates always sink to the bottom
      if (sortField === "due_date" && (!ka || !kb)) return !ka && !kb ? 0 : !ka ? 1 : -1;
      return ka < kb ? -dir : ka > kb ? dir : 0;
    });
  }

  return (
    <PageContainer width="wide" className="space-y-5">
      {/* Deep-link auto-opener — opens inspector for ?issue=<id> */}
      <Suspense>
        <IssueFocusOpener issues={rows} projectMap={projectMap} />
      </Suspense>

      <IssuesView
        issues={rows}
        projects={projects ?? []}
        projectMap={projectMap}
        dateDisplayPref={dateDisplayPref}
        canWrite={canWrite}
      />
    </PageContainer>
  );
}

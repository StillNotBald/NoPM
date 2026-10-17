import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryError } from "@/components/ui/query-error";
import { gatherTimeline } from "@/lib/timeline/gather";
import { todayIso } from "@/lib/timeline/dates";
import {
  fetchDependenciesForTasks,
  fetchWorkspaceDependencies,
  withProjectIds,
} from "@/lib/timeline/dependencies";
import { LensSwitcher } from "@/components/mainline/lens-switcher";
// Lens VALUES come from the plain lib module, never through the "use client"
// component file — an RSC importing non-component values across that boundary
// gets client-reference proxies, not the array/function (verified crash).
import { lensCaption, MAINLINE_LENSES, type MainlineLens } from "@/lib/mainline/lenses";
import { PortfolioLens } from "@/components/mainline/portfolio-lens";
import { ProjectLens, type ProjectLensData } from "@/components/mainline/project-lens";
import { DependencyLens, type DependencyEdgeRow } from "@/components/mainline/dependency-lens";

export const metadata = { title: "Mainline" };

type SearchParams = { [key: string]: string | string[] | undefined };

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * R-28 / L-12 — Mainline: the 3-lens portfolio timeline. Read-only; consumes
 * `gatherTimeline` (the same function `GET /api/timeline` calls — no new
 * data endpoint) plus, for the Journal (project) and Network (dependency)
 * lenses, direct session-scoped table reads (the exact idiom
 * `/projects/[id]/page.tsx` already uses for its milestones/tasks/
 * task_dependencies — not a new API route, just the established
 * "RSC reads searchParams + queries its own tables" pattern the dashboard
 * filter and every register page already follow).
 */
export default async function MainlinePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await db
    .from("profiles")
    .select("workspace_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) redirect("/login");

  const sp = await searchParams;
  const lensParam = firstParam(sp.lens);
  const lens: MainlineLens = (MAINLINE_LENSES as string[]).includes(lensParam ?? "")
    ? (lensParam as MainlineLens)
    : "portfolio";
  const requestedProjectId = firstParam(sp.project) ?? null;

  // A failed table read used to be swallowed into "no rows", which drew a
  // convincing but emptier timeline. Collect them and say so instead.
  const loadErrors: string[] = [];
  const graph = await gatherTimeline(db, profile.workspace_id, {
    today: todayIso(),
    onError: (table, message) => loadErrors.push(`${table}: ${message}`),
  });
  if (loadErrors.length > 0) {
    return <QueryError what="the portfolio timeline" message={loadErrors.join("; ")} />;
  }

  const projectOptions = graph.projects.map((p) => ({ id: p.id, label: `${p.code} — ${p.name}` }));
  const selectedProjectId =
    requestedProjectId && graph.projects.some((p) => p.id === requestedProjectId)
      ? requestedProjectId
      : (graph.projects[0]?.id ?? null);

  // Lens-level read failures render in place of the lens (the switcher stays
  // usable) rather than as an empty state.
  let lensError: { what: string; message: string } | null = null;

  let projectLensData: ProjectLensData | null = null;
  if (lens === "project" && selectedProjectId) {
    const [projectRes, milestonesRes, tasksRes] = await Promise.all([
      db
        .from("projects")
        .select("id, code, name, is_locked, lock_reason")
        .eq("id", selectedProjectId)
        .maybeSingle(),
      db
        .from("milestones")
        .select("id, project_id, name, target_date, baseline_target_date, status, completion_pct, owner_id, sort_order")
        .eq("project_id", selectedProjectId)
        .order("sort_order", { ascending: true }),
      db
        .from("tasks")
        .select(
          "id, project_id, milestone_id, name, description, status, status_type, priority, start_date, due_date, baseline_start_date, baseline_due_date, completion_pct, sort_order, assignee_id",
        )
        .eq("project_id", selectedProjectId)
        .order("sort_order", { ascending: true }),
    ]);

    // task_dependencies has no project_id column: scope it through this
    // project's task ids (same idiom as projects/[id]/page.tsx).
    const taskRows = tasksRes.data ?? [];
    const depsRes = tasksRes.error
      ? { data: [], error: null }
      : await fetchDependenciesForTasks(
          db,
          taskRows.map((t) => t.id),
        );

    const failure = projectRes.error
      ? { what: "the project", message: projectRes.error.message }
      : milestonesRes.error
        ? { what: "milestones", message: milestonesRes.error.message }
        : tasksRes.error
          ? { what: "tasks", message: tasksRes.error.message }
          : depsRes.error
            ? { what: "task dependencies", message: depsRes.error }
            : null;
    if (failure) lensError = failure;

    projectLensData = {
      project: projectRes.data ?? null,
      milestones: milestonesRes.data ?? [],
      tasks: taskRows,
      dependencies: depsRes.data,
    };
  }

  let dependencyRows: DependencyEdgeRow[] = [];
  if (lens === "dependency") {
    const depsRes = await fetchWorkspaceDependencies(db, profile.workspace_id);
    if (depsRes.error) {
      lensError = { what: "task dependencies", message: depsRes.error };
    } else {
      // project_id is derived from the tasks at each end (the table has none).
      const projectOfTask = new Map<string, string | null>();
      for (const n of graph.nodes) if (n.kind === "task") projectOfTask.set(n.id, n.projectId);
      dependencyRows = withProjectIds(depsRes.data, projectOfTask);
    }
  }

  const workspaceEmpty = graph.projects.length === 0;

  return (
    <div className="min-w-0 space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto min-w-0 max-w-6xl space-y-4">
        <PageHeader title="Mainline" action={<LensSwitcher lens={lens} />} />
        <p className="-mt-2 text-sm text-ink-muted">{lensCaption(lens)}</p>

        {workspaceEmpty ? (
          <EmptyState
            purpose="Mainline needs at least one project with a milestone or task to draw a timeline. Add a project to get started."
            canWrite={false}
            docsHref="/projects"
            docsLabel="Go to Projects"
          />
        ) : (
          <div role="tabpanel" id="mainline-panel" aria-labelledby={`mainline-tab-${lens}`} className="min-w-0">
            {lens === "portfolio" ? (
              <PortfolioLens graph={graph} />
            ) : lens === "project" ? (
              <ProjectLens
                projects={projectOptions}
                selectedProjectId={selectedProjectId}
                data={projectLensData}
                failure={lensError ? <LensFailure error={lensError} /> : undefined}
              />
            ) : lensError ? (
              <LensFailure error={lensError} />
            ) : (
              <DependencyLens graph={graph} dependencies={dependencyRows} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** QueryError without its page-level padding, for use inside the lens panel. */
function LensFailure({ error }: { error: { what: string; message: string } }) {
  return (
    <QueryError
      what={error.what}
      message={error.message}
      className="px-0! py-2! sm:px-0! sm:py-2! lg:px-0!"
    />
  );
}

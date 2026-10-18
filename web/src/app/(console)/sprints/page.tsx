import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { getWorkspaceTimeZone, todayInZone } from "@/lib/integrations/time-zone";
import { deriveBurndown, type AuditRowForBurndown } from "@/lib/insight/burndown";
import { computeVelocity } from "@/lib/insight/velocity";
import { deriveFlow, fetchTaskTransitions, type FlowAggregate } from "@/lib/insight/flow";
import { NewSprintButton } from "@/components/sprints/new-sprint-button";
import { SprintTransitionActions } from "@/components/sprints/sprint-transition-actions";
import { AttachTaskForm } from "@/components/sprints/attach-task-form";
import { BurndownChart } from "@/components/sprints/burndown-chart";
import { VelocityChart } from "@/components/sprints/velocity-chart";
import { sprintTimingFlag, sprintTimingMessage } from "@/lib/sprints/flags";
import { isUnfinished } from "@/lib/sprints/close";

export const metadata = { title: "Sprints" };

type SearchParams = { [key: string]: string | string[] | undefined };

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** flow.ts reports hours; the Flow card displays days (1 decimal) — display-only conversion. */
function formatFlowDays(hours: number | null): string {
  if (hours === null) return "—";
  return `${(hours / 24).toFixed(1)}d`;
}

interface SprintRow {
  id: string;
  project_id: string;
  name: string;
  goal: string | null;
  start_date: string;
  end_date: string;
  state: "planned" | "active" | "closed";
  committed_points: number | null;
  committed_snapshot: Record<string, number> | null;
  completed_points: number | null;
  completed_snapshot: Record<string, number> | null;
  started_at: string | null;
  closed_at: string | null;
}

interface ProjectRow {
  id: string;
  code: string | null;
  name: string;
}

// Active is in progress: the info hue, never the brand blue (DESIGN.md).
const STATE_TONE: Record<SprintRow["state"], "neutral" | "info" | "success"> = {
  planned: "neutral",
  active: "info",
  closed: "success",
};

/**
 * Sprints console (L-17/18/19/20) — sprint register grouped by project, with
 * an "Overlaps" flag when a project has more than one active sprint
 * (allowed by design, D8 — flagged here, never blocked). Selecting a sprint
 * (`?sprint=`) shows its commitment/scope-added counts, burndown, and — for
 * its project's closed sprints — velocity.
 *
 * Server component (auth redirect + RLS-scoped reads), matching
 * (console)/resources/page.tsx and the mainline `?lens=`/`?project=`
 * searchParams idiom. Interactive bits (create/start/close/attach) are
 * isolated client islands under components/sprints/*.
 */
export default async function SprintsPage({
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
    .select("role, workspace_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) redirect("/login");
  const canWrite = profile.role !== "viewer";

  const [{ data: sprints, error: sprintsError }, { data: projects }] = await Promise.all([
    db.from("sprints").select("*").order("start_date", { ascending: false }),
    db.from("projects").select("id, code, name").order("name"),
  ]);

  if (sprintsError) {
    return <QueryError what="sprints" message={sprintsError.message} />;
  }

  const sprintRows = (sprints ?? []) as SprintRow[];
  const projectRows = (projects ?? []) as ProjectRow[];
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const activeCountByProject = new Map<string, number>();
  for (const s of sprintRows) {
    if (s.state === "active") {
      activeCountByProject.set(s.project_id, (activeCountByProject.get(s.project_id) ?? 0) + 1);
    }
  }

  const sp = await searchParams;
  const requestedSprintId = firstParam(sp.sprint) ?? null;
  const selected =
    sprintRows.find((s) => s.id === requestedSprintId) ?? (sprintRows.length > 0 ? sprintRows[0] : null);

  const grouped = new Map<string, SprintRow[]>();
  for (const s of sprintRows) {
    const list = grouped.get(s.project_id) ?? [];
    list.push(s);
    grouped.set(s.project_id, list);
  }

  // ── Selected sprint detail: attached tasks, burndown, velocity, flow ─────
  let attachedTasks: {
    id: string;
    name: string;
    story_points: number | string | null;
    status_type: string;
    created_at: string;
  }[] = [];
  let burndownPoints: ReturnType<typeof deriveBurndown>["points"] = [];
  let scopeAddedCount = 0;
  let scopeAddedIds: string[] = [];
  let velocity: ReturnType<typeof computeVelocity> | null = null;
  let flow: FlowAggregate | null = null;

  if (selected) {
    // Burndown day boundaries follow the workspace time zone, not UTC.
    const workspaceZone = await getWorkspaceTimeZone(profile.workspace_id);
    const { data: attached } = await db
      .from("tasks")
      .select("id, name, story_points, status_type, created_at")
      .eq("sprint_id", selected.id);
    attachedTasks = attached ?? [];

    const taskIds = attachedTasks.map((t) => t.id);
    let auditRows: AuditRowForBurndown[] = [];
    if (taskIds.length > 0) {
      const { data: rows } = await db
        .from("audit_log")
        .select("target_id, before, after, created_at")
        .eq("target_type", "task")
        .eq("action", "task.update")
        .in("target_id", taskIds);
      auditRows = (rows ?? []) as AuditRowForBurndown[];
    }

    burndownPoints = deriveBurndown(
      {
        started_at: selected.started_at,
        end_date: selected.end_date,
        committed_points: selected.committed_points,
        committed_snapshot: selected.committed_snapshot,
      },
      attachedTasks.map((t) => ({ id: t.id, story_points: t.story_points })),
      auditRows,
      todayInZone(workspaceZone),
      workspaceZone,
    ).points;

    const committedIds = new Set(Object.keys(selected.committed_snapshot ?? {}));
    // Q-WRK-20: a task attached after the sprint started is "scope-added".
    scopeAddedIds =
      selected.state === "planned" ? [] : attachedTasks.filter((t) => !committedIds.has(t.id)).map((t) => t.id);
    scopeAddedCount = scopeAddedIds.length;

    const { data: closed } = await db
      .from("sprints")
      .select("id, name, committed_points, completed_points, closed_at")
      .eq("project_id", selected.project_id)
      .eq("state", "closed")
      .order("closed_at", { ascending: true });
    velocity = computeVelocity(closed ?? []);

    if (profile.workspace_id) {
      const transitionsByTask = await fetchTaskTransitions(db, profile.workspace_id, taskIds);
      const flowResult = deriveFlow(
        attachedTasks.map((t) => ({
          id: t.id,
          project_id: selected.project_id,
          sprint_id: selected.id,
          created_at: t.created_at,
        })),
        transitionsByTask,
      );
      flow = flowResult.bySprint.get(selected.id) ?? null;
    }
  }

  return (
    <PageContainer className="space-y-6">
      <div className="space-y-6">
        <PageHeader
          title="Sprints"
          action={canWrite ? <NewSprintButton /> : undefined}
        />

        {sprintRows.length === 0 ? (
          <Card>
            <EmptyState
              purpose="No sprints yet. Create a sprint under a project to plan and track commitment."
              action={<NewSprintButton />}
              canWrite={canWrite}
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            {/* ── Sprint list, grouped by project ─────────────────────────── */}
            <div className="space-y-4">
              {[...grouped.entries()].map(([projectId, projectSprints]) => {
                const project = projectById.get(projectId);
                const overlapping = (activeCountByProject.get(projectId) ?? 0) > 1;
                return (
                  <Card key={projectId}>
                    <CardHeader>
                      <CardTitle className="truncate">
                        {project ? (project.code ? `${project.code} — ${project.name}` : project.name) : "Unknown project"}
                      </CardTitle>
                      {overlapping && (
                        <Badge tone="warning" size="sm">
                          Overlaps
                        </Badge>
                      )}
                    </CardHeader>
                    <CardBody pad="compact">
                      <ul className="space-y-0.5">
                        {projectSprints.map((s) => (
                          <li key={s.id}>
                            <Link
                              href={`/sprints?sprint=${s.id}`}
                              className={cn(
                                "flex min-h-[44px] items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                                selected?.id === s.id ? "bg-well font-medium text-ink" : "text-ink-secondary hover:bg-well",
                              )}
                            >
                              <span className="truncate">{s.name}</span>
                              <span className="flex shrink-0 items-center gap-1">
                                {sprintTimingFlag(s) && (
                                  <Badge tone="warning" size="sm">
                                    {sprintTimingFlag(s) === "late_to_start" ? "Late to start" : "Past end"}
                                  </Badge>
                                )}
                                <Badge tone={STATE_TONE[s.state]} size="sm">
                                  {s.state}
                                </Badge>
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </CardBody>
                  </Card>
                );
              })}
            </div>

            {/* ── Selected sprint detail ──────────────────────────────────── */}
            {selected && (
              <div className="space-y-4 min-w-0">
                <Card>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle className="truncate">{selected.name}</CardTitle>
                      <p className="mt-0.5 font-mono text-xs tabular-nums text-ink-muted">
                        {selected.start_date} → {selected.end_date}
                      </p>
                      {selected.goal && <p className="mt-0.5 text-xs text-ink-muted truncate">{selected.goal}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={STATE_TONE[selected.state]} size="sm">
                        {selected.state}
                      </Badge>
                      {canWrite && (
                        <SprintTransitionActions
                          sprintId={selected.id}
                          state={selected.state}
                          hasAttachedTasks={attachedTasks.length > 0}
                          unfinishedCount={attachedTasks.filter((t) => isUnfinished(t.status_type)).length}
                          moveTargets={sprintRows
                            .filter((s) => s.project_id === selected.project_id && s.id !== selected.id && s.state !== "closed")
                            .map((s) => ({ id: s.id, name: s.name }))}
                        />
                      )}
                    </div>
                  </CardHeader>
                  {sprintTimingMessage(sprintTimingFlag(selected)) && (
                    <p
                      role="status"
                      className="mx-4 mb-3 rounded-md border border-border-subtle bg-well px-3 py-2 text-sm text-ink-secondary"
                    >
                      {sprintTimingMessage(sprintTimingFlag(selected))}
                    </p>
                  )}
                  <CardBody>
                    <div className="grid grid-cols-3 gap-3 sm:gap-4">
                      <div>
                        <p className="text-xs text-ink-muted uppercase tracking-wide">Committed</p>
                        <p className="mt-1 font-mono text-xl font-semibold text-ink tabular-nums">
                          {selected.committed_points ?? "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-ink-muted uppercase tracking-wide">Completed</p>
                        <p className="mt-1 font-mono text-xl font-semibold text-ink tabular-nums">
                          {selected.completed_points ?? "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-ink-muted uppercase tracking-wide">Scope-added</p>
                        <p className="mt-1 font-mono text-xl font-semibold text-ink tabular-nums">
                          {selected.state === "planned" ? "—" : scopeAddedCount}
                        </p>
                      </div>
                    </div>
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Burndown</CardTitle>
                  </CardHeader>
                  <CardBody>
                    <BurndownChart points={burndownPoints} />
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Velocity</CardTitle>
                  </CardHeader>
                  <CardBody>{velocity && <VelocityChart velocity={velocity} />}</CardBody>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Flow</CardTitle>
                  </CardHeader>
                  <CardBody>
                    {!flow || flow.sampleSize === 0 ? (
                      <p className="text-sm text-ink-muted">No attached tasks yet — nothing to measure.</p>
                    ) : (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3 sm:gap-4">
                          <div>
                            <p className="text-xs text-ink-muted uppercase tracking-wide">Cycle time (median / p85)</p>
                            <p className="mt-1 font-mono text-lg font-semibold text-ink tabular-nums">
                              {formatFlowDays(flow.cycleTimeHoursMedian)} / {formatFlowDays(flow.cycleTimeHoursP85)}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-ink-muted uppercase tracking-wide">Lead time (median / p85)</p>
                            <p className="mt-1 font-mono text-lg font-semibold text-ink tabular-nums">
                              {formatFlowDays(flow.leadTimeHoursMedian)} / {formatFlowDays(flow.leadTimeHoursP85)}
                            </p>
                          </div>
                        </div>
                        <p className="text-xs text-ink-muted">
                          {flow.cycleExcludedCount} of {flow.sampleSize} excluded from cycle time (never entered
                          Started, or not yet completed); {flow.leadExcludedCount} excluded from lead time (not yet
                          completed). A task that was reopened and completed again counts from its LATEST
                          completion, not its first.
                        </p>
                      </div>
                    )}
                  </CardBody>
                </Card>

                {canWrite && selected.state !== "closed" && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Tasks</CardTitle>
                    </CardHeader>
                    <CardBody>
                      <AttachTaskForm
                        sprintId={selected.id}
                        projectId={selected.project_id}
                        attachedTasks={attachedTasks}
                        scopeAddedIds={scopeAddedIds}
                      />
                    </CardBody>
                  </Card>
                )}

                {(!canWrite || selected.state === "closed") && attachedTasks.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Tasks</CardTitle>
                    </CardHeader>
                    <CardBody pad="compact">
                      <ul className="divide-y divide-border-subtle">
                        {attachedTasks.map((t) => (
                          <li key={t.id} className="flex items-center gap-2 px-2 py-2 text-sm text-ink-secondary">
                            <span className="truncate">{t.name}</span>
                            {scopeAddedIds.includes(t.id) && (
                              <Badge tone="warning" size="sm">
                                Scope-added
                              </Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    </CardBody>
                  </Card>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </PageContainer>
  );
}

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EmptyState } from "@/components/ui/empty-state";
import {
  GanttChart,
  type Milestone,
  type Task,
  type TaskDependency,
} from "@/components/tracking/gantt";

export interface ProjectLensOption {
  id: string;
  label: string;
}

export interface ProjectLensData {
  project: { id: string; code: string; name: string; is_locked: boolean; lock_reason: string | null } | null;
  milestones: Milestone[];
  tasks: Task[];
  dependencies: TaskDependency[];
}

/**
 * Lens 2 — Journal (Project): pick a project, see its milestones + tasks +
 * dependency edges. Reuses <GanttChart> verbatim (same component
 * `/projects/[id]` renders) so a locked project renders baseline-vs-actual
 * ghost bars identically — no re-derivation of that logic here (register
 * criterion: "Locked projects render baseline-vs-actual, matching
 * /projects/[id]").
 */
export function ProjectLens({
  projects,
  selectedProjectId,
  data,
}: {
  projects: ProjectLensOption[];
  selectedProjectId: string | null;
  data: ProjectLensData | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function selectProject(id: string) {
    const qs = new URLSearchParams(searchParams.toString());
    qs.set("lens", "project");
    qs.set("project", id);
    router.push(`${pathname}?${qs.toString()}`);
  }

  if (projects.length === 0) {
    return <EmptyState purpose="No projects yet — the Journal lens needs at least one project to pick from." canWrite={false} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Stacks below sm — the select's longest option (a full project
          code + name) otherwise sizes it past the viewport edge, same
          quirk fixed for the dashboard's Project filter (F3). */}
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
        <label htmlFor="mainline-project-picker" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          Project
        </label>
        <select
          id="mainline-project-picker"
          value={selectedProjectId ?? ""}
          onChange={(e) => selectProject(e.target.value)}
          className="h-11 w-full sm:h-9 sm:w-auto sm:min-w-[12rem] rounded-md border border-border-subtle bg-canvas px-2.5 text-base text-ink sm:text-sm focus-ring"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {data?.project ? (
        data.milestones.length === 0 && data.tasks.length === 0 ? (
          <EmptyState purpose={`${data.project.name} has no milestones or tasks yet.`} canWrite={false} />
        ) : (
          <GanttChart
            projectId={data.project.id}
            milestones={data.milestones}
            tasks={data.tasks}
            isLocked={data.project.is_locked}
            dependencies={data.dependencies}
          />
        )
      ) : (
        <EmptyState purpose="Project not found in this workspace." canWrite={false} />
      )}
    </div>
  );
}

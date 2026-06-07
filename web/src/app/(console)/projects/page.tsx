import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

type RagStatus = "not_started" | "red" | "amber" | "green" | "complete";

function ragTone(rag: RagStatus): "neutral" | "danger" | "warning" | "success" | "accent" {
  switch (rag) {
    case "green": return "success";
    case "amber": return "warning";
    case "red": return "danger";
    case "complete": return "accent";
    default: return "neutral";
  }
}

function ragLabel(rag: RagStatus): string {
  switch (rag) {
    case "not_started": return "Not started";
    case "red": return "Red";
    case "amber": return "Amber";
    case "green": return "Green";
    case "complete": return "Complete";
  }
}

export default async function ProjectsPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const { data: projects, error } = await db
    .from("projects")
    .select("id, code, name, rag_status, completion_pct, target_date, is_locked, program")
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div className="p-8">
        <p className="text-sm text-danger">Failed to load projects: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-ink">Projects</h1>
        <p className="mt-1 text-sm text-ink-muted">
          All projects in your workspace
        </p>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border-subtle bg-surface overflow-hidden">
        {projects && projects.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-sunken/50">
                <th className="px-4 py-3 text-left font-medium text-ink-secondary w-24">Code</th>
                <th className="px-4 py-3 text-left font-medium text-ink-secondary">Name</th>
                <th className="px-4 py-3 text-left font-medium text-ink-secondary w-32">Program</th>
                <th className="px-4 py-3 text-left font-medium text-ink-secondary w-28">RAG</th>
                <th className="px-4 py-3 text-right font-medium text-ink-secondary w-28">Completion</th>
                <th className="px-4 py-3 text-left font-medium text-ink-secondary w-32">Target date</th>
                <th className="px-4 py-3 text-left font-medium text-ink-secondary w-20">Status</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project, i) => (
                <tr
                  key={project.id}
                  className={cn(
                    "transition-colors hover:bg-sunken/40",
                    i < projects.length - 1 && "border-b border-border-subtle",
                  )}
                >
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-ink-muted">
                      {project.code ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/projects/${project.id}`}
                      className="font-medium text-ink hover:text-accent transition-colors"
                    >
                      {project.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {project.program ?? <span className="text-ink-muted">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={ragTone(project.rag_status as RagStatus)}>
                      {ragLabel(project.rag_status as RagStatus)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-20 h-1.5 rounded-full bg-sunken overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${project.completion_pct ?? 0}%` }}
                        />
                      </div>
                      <span className="text-xs text-ink-secondary tabular-nums w-8 text-right">
                        {Math.round(project.completion_pct ?? 0)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {project.target_date
                      ? new Date(project.target_date).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })
                      : <span className="text-ink-muted">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {project.is_locked ? (
                      <Badge tone="warning">Locked</Badge>
                    ) : (
                      <span className="text-xs text-ink-muted">Active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="py-16 text-center">
            <p className="text-sm text-ink-muted">No projects yet.</p>
          </div>
        )}
      </div>

      {projects && projects.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">{projects.length} project{projects.length !== 1 ? "s" : ""}</p>
      )}
    </div>
  );
}

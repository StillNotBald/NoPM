import Link from "next/link";
import { ragLabel } from "@/lib/status";
import type { TLGraph } from "@/lib/timeline/gather";

const KIND_LABEL: Record<string, string> = {
  delivery: "Delivery",
  resource: "Resource",
  decision: "Decision",
  risk: "Risk",
};

/**
 * Project-to-project dependencies (R-147) for the Network lens: one stacked row per
 * declared link, "A depends on B", with both declared health labels in words (never
 * colour alone). A project that depends on a red one is called out as contingent.
 */
export function ProjectDependencySection({ graph }: { graph: TLGraph }) {
  const byId = new Map(graph.projects.map((p) => [p.id, p] as const));
  const rows = graph.projectDependencies
    .map((d) => ({ d, from: byId.get(d.projectId), to: byId.get(d.dependsOnProjectId) }))
    .filter((r) => r.from && r.to);

  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="mainline-project-deps" className="rounded-lg border border-border-subtle bg-surface p-4">
      <h3 id="mainline-project-deps" className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Project dependencies
      </h3>
      <ul className="divide-y divide-border-subtle">
        {rows.map(({ d, from, to }) => {
          const contingent = to!.ragStatus === "red" && from!.ragStatus !== "red" && from!.ragStatus !== "complete";
          return (
            <li key={d.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
              <p className="min-w-0 break-words text-sm text-ink">
                <Link href={`/projects/${from!.id}`} className="focus-ring font-medium text-accent underline underline-offset-2">
                  {from!.code}
                </Link>{" "}
                <span className="text-ink-muted">({ragLabel(from!.ragStatus)})</span> depends on{" "}
                <Link href={`/projects/${to!.id}`} className="focus-ring font-medium text-accent underline underline-offset-2">
                  {to!.code}
                </Link>{" "}
                <span className="text-ink-muted">({ragLabel(to!.ragStatus)})</span>
              </p>
              <p className="text-xs text-ink-secondary">
                {KIND_LABEL[d.kind] ?? d.kind}
                {d.note ? ` · ${d.note}` : ""}
                {contingent ? " · Contingent on a delayed project" : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

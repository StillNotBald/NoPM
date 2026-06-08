"use client";

import { Badge } from "@/components/ui/badge";
import { DecisionRowButton } from "@/components/decisions/decision-detail";
import type { Decision } from "@/components/decisions/decision-form";
import type { Tone } from "@/lib/status";

// ── Local helpers ─────────────────────────────────────────────────────────────

type DecisionStatus = Decision["status"];

function statusTone(s: DecisionStatus): Tone {
  if (s === "accepted") return "success";
  if (s === "rejected") return "danger";
  if (s === "superseded") return "warning";
  return "info"; // proposed
}

function statusLabel(s: DecisionStatus): string {
  const labels: Record<DecisionStatus, string> = {
    proposed: "Proposed",
    accepted: "Accepted",
    superseded: "Superseded",
    rejected: "Rejected",
  };
  return labels[s] ?? s;
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ── DecisionTable ─────────────────────────────────────────────────────────────

interface DecisionTableProps {
  rows: Decision[];
  projectMap: Record<string, string>;
  refMap: Record<string, string>; // decision id → reference_id (for supersedes display)
  projects: Array<{ id: string; name: string }>;
}

export function DecisionTable({ rows, projectMap, refMap, projects }: DecisionTableProps) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-16 text-center">
        <p className="text-sm text-ink-muted">No decisions logged yet.</p>
        <p className="mt-1 text-xs text-ink-muted">
          Use &ldquo;Add Decision&rdquo; to record the first one.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] text-sm">
        <thead>
          <tr className="border-b border-border-subtle">
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
              Ref
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
              Title
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
              Decision
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
              Status
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
              Decided By
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
              Date
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((d) => (
            <DecisionRowButton
              key={d.id}
              decision={d}
              projectName={d.project_id ? (projectMap[d.project_id] ?? undefined) : undefined}
              supersededByRef={d.supersedes ? (refMap[d.supersedes] ?? null) : null}
              projects={projects}
            >
              <td className="px-5 py-3.5">
                {d.reference_id ? (
                  <span className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted">
                    {d.reference_id}
                  </span>
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </td>
              <td className="px-5 py-3.5 font-medium text-ink max-w-[200px] truncate">
                {d.title}
              </td>
              <td className="px-5 py-3.5 text-ink-secondary max-w-[200px] truncate">
                {d.decision ?? "—"}
              </td>
              <td className="px-5 py-3.5">
                <Badge tone={statusTone(d.status)}>{statusLabel(d.status)}</Badge>
              </td>
              <td className="px-5 py-3.5 text-ink-secondary">
                {d.decided_by_label ?? "—"}
              </td>
              <td className="px-5 py-3.5 text-ink-secondary tabular-nums">
                {formatDate(d.decided_at)}
              </td>
            </DecisionRowButton>
          ))}
        </tbody>
      </table>
    </div>
  );
}

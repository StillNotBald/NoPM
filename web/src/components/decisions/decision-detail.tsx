"use client";

import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DecisionForm, type Decision } from "@/components/decisions/decision-form";
import type { Tone } from "@/lib/status";

// ── Local type helpers ────────────────────────────────────────────────────────

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

// ── DetailRow ─────────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 border-b border-border-subtle last:border-0">
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

function TextValue({ value }: { value: string | null | undefined }) {
  if (!value || value.trim() === "") {
    return <span className="text-ink-muted">—</span>;
  }
  return <span className="whitespace-pre-wrap">{value}</span>;
}

// ── DecisionDetail ────────────────────────────────────────────────────────────

export interface DecisionDetailProps {
  decision: Decision;
  projectName?: string;
  supersededByRef?: string | null;
  projects: Array<{ id: string; name: string }>;
}

export function DecisionDetail({
  decision,
  projectName,
  supersededByRef,
  projects,
}: DecisionDetailProps) {
  const inspector = useInspector();

  function openEdit() {
    inspector.open(
      <DecisionForm projects={projects} decision={decision} />,
      "Edit Decision",
    );
  }

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 pb-3 border-b border-border-subtle mb-1">
        <div className="flex-1 min-w-0">
          {decision.reference_id && (
            <span className="font-mono text-[11px] bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted mb-1 inline-block">
              {decision.reference_id}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {decision.title}
          </h2>
        </div>
        <Button variant="ghost" onClick={openEdit} className="shrink-0 h-9 px-3 text-xs">
          Edit
        </Button>
      </div>

      {/* Status chip */}
      <div className="flex flex-wrap gap-2 py-2.5 border-b border-border-subtle">
        <Badge tone={statusTone(decision.status)}>{statusLabel(decision.status)}</Badge>
      </div>

      {/* Fields */}
      <div>
        <DetailRow label="Project">
          <TextValue value={projectName} />
        </DetailRow>

        <DetailRow label="Decided By">
          <TextValue value={decision.decided_by_label} />
        </DetailRow>

        <DetailRow label="Decision Date">
          <span className="tabular-nums">{formatDate(decision.decided_at)}</span>
        </DetailRow>

        {decision.decision && decision.decision.trim() !== "" && (
          <DetailRow label="The Decision">
            <TextValue value={decision.decision} />
          </DetailRow>
        )}

        {decision.context && decision.context.trim() !== "" && (
          <DetailRow label="Context">
            <TextValue value={decision.context} />
          </DetailRow>
        )}

        {decision.options && decision.options.trim() !== "" && (
          <DetailRow label="Options Considered">
            <TextValue value={decision.options} />
          </DetailRow>
        )}

        {decision.rationale && decision.rationale.trim() !== "" && (
          <DetailRow label="Rationale">
            <TextValue value={decision.rationale} />
          </DetailRow>
        )}

        {decision.supersedes && (
          <DetailRow label="Supersedes">
            <span className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted">
              {supersededByRef ?? decision.supersedes.slice(0, 8) + "…"}
            </span>
          </DetailRow>
        )}
      </div>
    </div>
  );
}

// ── DecisionRowButton — clickable <tr> wrapper ────────────────────────────────

export function DecisionRowButton({
  decision,
  projectName,
  supersededByRef,
  projects,
  children,
}: DecisionDetailProps & { children: React.ReactNode }) {
  const inspector = useInspector();

  function open() {
    inspector.open(
      <DecisionDetail
        decision={decision}
        projectName={projectName}
        supersededByRef={supersededByRef}
        projects={projects}
      />,
      decision.reference_id ? `Decision ${decision.reference_id}` : "Decision",
    );
  }

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="hover:bg-sunken transition-colors duration-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      {children}
    </tr>
  );
}

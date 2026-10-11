"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { ChangeForm, type ChangeRequest } from "@/components/change-control/change-form";
import { FieldLabel, FieldError, TextareaInput } from "@/components/forms/project-form";
import { apiPost, type ApiError } from "@/lib/api-client";
import type { Tone } from "@/lib/status";

// ── Local type helpers ────────────────────────────────────────────────────────

type CRStatus = ChangeRequest["status"];
type CRCategory = ChangeRequest["category"];
type CRPriority = ChangeRequest["priority"];

function statusTone(s: CRStatus): Tone {
  if (s === "approved" || s === "implemented") return "success";
  if (s === "rejected") return "danger";
  if (s === "deferred") return "warning";
  if (s === "under_review") return "info";
  return "neutral"; // raised
}

function statusLabel(s: CRStatus): string {
  const labels: Record<CRStatus, string> = {
    raised: "Raised",
    under_review: "Under Review",
    approved: "Approved",
    rejected: "Rejected",
    deferred: "Deferred",
    implemented: "Implemented",
  };
  return labels[s] ?? s;
}

function priorityTone(p: CRPriority): Tone {
  if (p === "critical") return "danger";
  if (p === "high") return "warning";
  if (p === "medium") return "info";
  return "neutral";
}

const CATEGORY_LABELS: Record<CRCategory, string> = {
  scope: "Scope",
  schedule: "Schedule",
  cost: "Cost",
  quality: "Quality",
  resource: "Resource",
  other: "Other",
};

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatCurrency(val: number | null | undefined) {
  if (val == null) return "—";
  const abs = Math.abs(val);
  const sign = val < 0 ? "-" : val > 0 ? "+" : "";
  return `${sign}${abs.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

// ── DetailRow ─────────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 border-b border-border-subtle last:border-0">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
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

// ── DecisionPanel — four-eyes approve/reject/defer ────────────────────────────

export interface DecisionPanelProps {
  crId: string;
  onDecided: () => void;
}

export function DecisionPanel({ crId, onDecided }: DecisionPanelProps) {
  const [decision, setDecision] = useState<"approve" | "reject" | "defer" | null>(null);
  const [rationale, setRationale] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!decision) return;
    setError(null);
    setFieldErrors({});
    setSaving(true);

    try {
      await apiPost(`/api/change-requests/${crId}/decision`, {
        decision,
        rationale: rationale.trim() || null,
      });
      onDecided();
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message ?? "Failed to record decision.");
      const map: Record<string, string> = {};
      for (const f of apiErr.fields ?? []) map[f.field] = f.message;
      setFieldErrors(map);
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border-subtle bg-sunken p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-3">
        Record Decision
      </h3>

      {error && (
        <div className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Decision buttons */}
        <div>
          <FieldLabel>Decision</FieldLabel>
          <div className="flex gap-2 mt-1">
            <button
              type="button"
              onClick={() => setDecision("approve")}
              className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                decision === "approve"
                  ? "border-success bg-success/15 text-success"
                  : "border-border-subtle bg-canvas text-ink-secondary hover:bg-sunken"
              }`}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => setDecision("reject")}
              className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                decision === "reject"
                  ? "border-danger bg-danger/15 text-danger"
                  : "border-border-subtle bg-canvas text-ink-secondary hover:bg-sunken"
              }`}
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => setDecision("defer")}
              className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                decision === "defer"
                  ? "border-warning bg-warning/15 text-warning"
                  : "border-border-subtle bg-canvas text-ink-secondary hover:bg-sunken"
              }`}
            >
              Defer
            </button>
          </div>
          {fieldErrors.decision && (
            <FieldError message={fieldErrors.decision} />
          )}
        </div>

        {/* Rationale */}
        <div>
          <FieldLabel>Rationale</FieldLabel>
          <TextareaInput
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Explain the reasoning behind this decision…"
            rows={2}
          />
          <FieldError message={fieldErrors.rationale} />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving || !decision}
          >
            {saving ? (
              <>
                <Spinner size="sm" className="mr-1.5" />
                Saving…
              </>
            ) : (
              "Submit Decision"
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ── ChangeDetail ──────────────────────────────────────────────────────────────

export interface ChangeDetailProps {
  cr: ChangeRequest;
  projectName?: string;
  projects: Array<{ id: string; name: string }>;
}

export function ChangeDetail({ cr, projectName, projects }: ChangeDetailProps) {
  const inspector = useInspector();
  const router = useRouter();
  const [decided, setDecided] = useState(false);

  function openEdit() {
    inspector.open(
      <ChangeForm projects={projects} changeRequest={cr} />,
      "Edit Change Request",
    );
  }

  function handleDecided() {
    setDecided(true);
    router.refresh();
    inspector.close();
  }

  const canDecide = !decided && (cr.status === "raised" || cr.status === "under_review");

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 pb-3 border-b border-border-subtle mb-1">
        <div className="flex-1 min-w-0">
          {cr.reference_id && (
            <span className="font-mono text-[11px] bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted mb-1 inline-block">
              {cr.reference_id}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {cr.title}
          </h2>
        </div>
        <Button variant="ghost" onClick={openEdit} className="shrink-0 h-9 px-3 text-xs">
          Edit
        </Button>
      </div>

      {/* Status / priority chips */}
      <div className="flex flex-wrap gap-2 py-2.5 border-b border-border-subtle">
        <Badge tone={statusTone(cr.status)}>{statusLabel(cr.status)}</Badge>
        <Badge tone={priorityTone(cr.priority)}>{cr.priority}</Badge>
        <Badge tone="neutral">{CATEGORY_LABELS[cr.category] ?? cr.category}</Badge>
      </div>

      {/* Fields */}
      <div>
        <DetailRow label="Project">
          <TextValue value={projectName} />
        </DetailRow>

        <DetailRow label="Requested By">
          <TextValue value={cr.requested_by_label} />
        </DetailRow>

        <DetailRow label="Raised">
          <span className="tabular-nums">{formatDate(cr.raised_at)}</span>
        </DetailRow>

        <DetailRow label="Target Date">
          <span className="tabular-nums">{formatDate(cr.target_date)}</span>
        </DetailRow>

        {cr.impact_summary && cr.impact_summary.trim() !== "" && (
          <DetailRow label="Impact Summary">
            <TextValue value={cr.impact_summary} />
          </DetailRow>
        )}

        <DetailRow label="Schedule Impact">
          {cr.impact_schedule_days != null ? (
            <span className="font-mono text-sm tabular-nums">
              {cr.impact_schedule_days > 0 ? "+" : ""}
              {cr.impact_schedule_days} days
            </span>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </DetailRow>

        <DetailRow label="Cost Impact">
          {cr.impact_cost != null ? (
            <span className="font-mono text-sm tabular-nums">
              {formatCurrency(cr.impact_cost)}
            </span>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </DetailRow>

        {cr.description && cr.description.trim() !== "" && (
          <DetailRow label="Description">
            <TextValue value={cr.description} />
          </DetailRow>
        )}

        {/* Decision fields — shown when decided */}
        {cr.decided_by_label && (
          <DetailRow label="Decided By">
            <TextValue value={cr.decided_by_label} />
          </DetailRow>
        )}

        {cr.decided_at && (
          <DetailRow label="Decision Date">
            <span className="tabular-nums">{formatDate(cr.decided_at)}</span>
          </DetailRow>
        )}

        {cr.decision_rationale && cr.decision_rationale.trim() !== "" && (
          <DetailRow label="Decision Rationale">
            <TextValue value={cr.decision_rationale} />
          </DetailRow>
        )}
      </div>

      {/* Decision panel — only for actionable CRs */}
      {canDecide && (
        <DecisionPanel crId={cr.id} onDecided={handleDecided} />
      )}
    </div>
  );
}


"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { ChangeForm, type ChangeRequest } from "@/components/change-control/change-form";
import { TextareaInput } from "@/components/forms/project-form";
import { DecisionRefusal } from "@/components/governance/decision-refusal";
import { FourEyesNote, type DecideState } from "@/components/governance/four-eyes-note";
import { describeRefusal, fieldMessages, type Refusal } from "@/components/governance/refusal";
import { Field, InlineAlert } from "@/components/integrations/shared";
import { apiPost } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/status";

// ── Local type helpers ────────────────────────────────────────────────────────

type CRStatus = ChangeRequest["status"];
type CRCategory = ChangeRequest["category"];
type CRPriority = ChangeRequest["priority"];

export function statusTone(s: CRStatus): Tone {
  if (s === "approved" || s === "implemented") return "success";
  if (s === "rejected") return "danger";
  if (s === "deferred") return "warning";
  if (s === "under_review") return "info";
  return "neutral"; // raised
}

export function statusLabel(s: CRStatus): string {
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

export function priorityTone(p: CRPriority): Tone {
  if (p === "critical") return "danger";
  if (p === "high") return "warning";
  if (p === "medium") return "info";
  return "neutral";
}

export const CATEGORY_LABELS: Record<CRCategory, string> = {
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

// ── ChangeFacts — the record, read-only ───────────────────────────────────────

/** What the facts list reads; the review queue builds this from its own summary. */
export type ChangeFactsData = Pick<
  ChangeRequest,
  | "status"
  | "priority"
  | "category"
  | "requested_by_label"
  | "raised_at"
  | "target_date"
  | "impact_summary"
  | "impact_schedule_days"
  | "impact_cost"
  | "description"
> &
  Partial<Pick<ChangeRequest, "decided_by_label" | "decided_at" | "decision_rationale">>;

/**
 * The change request as the person deciding it needs to read it: status and
 * priority, who asked, when, and the impact (schedule, cost, summary). Used by
 * the change-control inspector and the review-queue inspector, so both put the
 * same record beside the decision.
 */
export function ChangeFacts({ cr, projectName }: { cr: ChangeFactsData; projectName?: string }) {
  return (
    <>
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
    </>
  );
}

// ── DecisionPanel — four-eyes approve/reject/defer ────────────────────────────

type Decision = "approve" | "reject" | "defer";

const DECISION_OPTIONS: { value: Decision; label: string; selected: string }[] = [
  { value: "approve", label: "Approve", selected: "border-success bg-success/15 text-success-ink" },
  { value: "reject", label: "Reject", selected: "border-danger bg-danger/15 text-danger-ink" },
  { value: "defer", label: "Defer", selected: "border-warning bg-warning/15 text-warning-ink" },
];

export interface DecisionPanelProps {
  crId: string;
  onDecided: () => void;
  /**
   * Server-computed: may this viewer decide it? When not, the four-eyes note
   * replaces the form (a decision that will be refused is never offered).
   */
  decide?: DecideState;
  /**
   * The `updated_at` of the request as the viewer saw it. Sent with the
   * decision so an edit made after the panel opened is refused (412) instead of
   * approving content the approver never read.
   */
  expectedUpdatedAt?: string | null;
}

export function DecisionPanel({ crId, onDecided, decide, expectedUpdatedAt }: DecisionPanelProps) {
  const router = useRouter();
  const uid = useId();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [rationale, setRationale] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const focusRationale = () => formRef.current?.querySelector<HTMLElement>("textarea")?.focus();

  // Once a decision is picked, the next thing to do is explain it.
  useEffect(() => {
    if (decision) focusRationale();
  }, [decision]);

  if (decide && !decide.canDecide) {
    return <FourEyesNote block={decide.block} className="mt-4" />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!decision) return;
    // The API requires a rationale for every decision; say so before the round trip.
    if (!rationale.trim()) {
      setFieldErrors({ rationale: "Give a reason for the decision." });
      focusRationale();
      return;
    }
    setError(null);
    setFieldErrors({});
    setSaving(true);

    try {
      await apiPost(`/api/change-requests/${crId}/decision`, {
        decision,
        rationale: rationale.trim(),
        ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {}),
      });
      onDecided();
    } catch (err) {
      const found = describeRefusal(err, "Failed to record decision.");
      if (found.terminal) {
        setRefusal(found);
      } else {
        setError(found.detail);
        setFieldErrors(fieldMessages(err));
      }
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border-subtle bg-sunken p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-3">
        Record Decision
      </h3>

      {refusal ? (
        <DecisionRefusal
          refusal={refusal}
          onBack={() => setRefusal(null)}
          onRefresh={() => {
            setRefusal(null);
            router.refresh();
          }}
        />
      ) : (
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-3">
          {error && <InlineAlert>{error}</InlineAlert>}

          {/* Decision: native radios, so arrows/space/screen readers work for free */}
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-muted">
              Decision
            </legend>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {DECISION_OPTIONS.map((opt) => {
                const isSelected = decision === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={cn(
                      "flex min-h-[44px] cursor-pointer items-center justify-center rounded-md border px-3 text-xs font-medium transition-colors sm:min-h-9",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                      isSelected
                        ? opt.selected
                        : "border-border-subtle bg-canvas text-ink-secondary hover:bg-sunken",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${uid}-decision`}
                      value={opt.value}
                      checked={isSelected}
                      onChange={() => setDecision(opt.value)}
                      className="sr-only"
                    />
                    {opt.label}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <Field id={`${uid}-rationale`} label="Rationale (required)" error={fieldErrors.rationale}>
            {(a11y) => (
              <TextareaInput
                {...a11y}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Explain the reasoning behind this decision…"
                rows={2}
                aria-required="true"
              />
            )}
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="h-11 w-full sm:h-8 sm:w-auto"
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
      )}
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
            <span className="font-mono text-2xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted mb-1 inline-block">
              {cr.reference_id}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {cr.title}
          </h2>
        </div>
        <Button variant="ghost" onClick={openEdit} className="shrink-0 h-11 px-3 text-xs sm:h-9">
          Edit
        </Button>
      </div>

      <ChangeFacts cr={cr} projectName={projectName} />

      {/* Decision panel — only for actionable CRs */}
      {canDecide && (
        <DecisionPanel crId={cr.id} onDecided={handleDecided} decide={cr.decide} expectedUpdatedAt={cr.updated_at} />
      )}
    </div>
  );
}

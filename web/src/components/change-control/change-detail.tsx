"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { tierLabel } from "@/components/governance/tier-label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { AREA_LABELS, DIRECTION_LABELS, ChangeForm, isEmergencyChange, type ChangeRequest } from "@/components/change-control/change-form";
import { EvidencePanel } from "@/components/change-control/evidence-panel";
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
    emergency: "Emergency",
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
  Partial<
    Pick<
      ChangeRequest,
      | "decided_by_label"
      | "decided_at"
      | "decision_rationale"
      | "impact_scope"
      | "implemented_at"
      | "implemented_by_label"
      | "implemented_note"
      | "decisions"
      | "tier"
      | "approval_deadline_at"
      | "is_emergency"
      | "deadline_overdue"
    >
  >;

const DIRECTION_TONE: Record<string, Tone> = { increase: "warning", decrease: "info", neutral: "neutral" };

/**
 * The change request as the person deciding it needs to read it: status and
 * priority, who asked, when, and the impact (schedule, cost, summary). Used by
 * the change-control inspector and the review-queue inspector, so both put the
 * same record beside the decision.
 */
/**
 * R-159 (owner decision Q1): an emergency change commits when it is raised. Nobody approves it and nothing
 * is owed afterwards, so the detail only says so plainly and keeps the flag visible.
 */
export function emergencyNoteText(cr: { raised_at?: string | null; requested_by_label?: string | null }): string {
  return `Emergency change: committed without approval on ${formatDate(cr.raised_at ?? null)} by ${cr.requested_by_label ?? "the raiser"}`;
}

function EmergencyNote({ cr }: { cr: ChangeFactsData }) {
  return (
    <p role="status" className="my-2 rounded-md bg-danger/15 px-3 py-2 text-sm text-danger-ink">
      {emergencyNoteText(cr)}
    </p>
  );
}

export function ChangeFacts({ cr, projectName }: { cr: ChangeFactsData; projectName?: string }) {
  return (
    <>
      {/* Status / priority chips */}
      <div className="flex flex-wrap gap-2 py-2.5 border-b border-border-subtle">
        <Badge tone={statusTone(cr.status)}>{statusLabel(cr.status)}</Badge>
        {isEmergencyChange(cr) && <Badge tone="danger">Emergency</Badge>}
        <Badge tone={priorityTone(cr.priority)}>{cr.priority}</Badge>
        <Badge tone="neutral">{CATEGORY_LABELS[cr.category] ?? cr.category}</Badge>
        {/* UAT-005: the tier is always shown (a Normal request included) */}
        {cr.tier && cr.tier !== "emergency" && (
          <Badge tone={cr.tier === "routine" || cr.tier === "normal" ? "neutral" : "warning"}>{tierLabel(cr.tier)}</Badge>
        )}
      </div>

      {isEmergencyChange(cr) && <EmergencyNote cr={cr} />}

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

        {cr.approval_deadline_at && ["raised", "under_review"].includes(cr.status) && (
          <DetailRow label="Decision due">
            <span className={cr.deadline_overdue ? "font-medium text-danger-ink tabular-nums" : "tabular-nums"}>
              {formatDate(cr.approval_deadline_at)}
              {cr.deadline_overdue ? " (overdue)" : ""}
            </span>
          </DetailRow>
        )}

        <DetailRow label="Target Date">
          <span className="tabular-nums">{formatDate(cr.target_date)}</span>
        </DetailRow>

        {cr.impact_summary && cr.impact_summary.trim() !== "" && (
          <DetailRow label="Impact Summary">
            <TextValue value={cr.impact_summary} />
          </DetailRow>
        )}

        {cr.impact_scope && cr.impact_scope.length > 0 && (
          <DetailRow label="Impact by Area">
            <ul className="flex flex-wrap gap-2" aria-label="Impact by area">
              {cr.impact_scope.map((item) => (
                <li key={item.area} className="max-w-full">
                  <Badge tone={DIRECTION_TONE[item.direction] ?? "neutral"}>
                    {AREA_LABELS[item.area] ?? item.area}: {(DIRECTION_LABELS[item.direction] ?? item.direction).toLowerCase()}
                  </Badge>
                  {item.note && <span className="mt-0.5 block text-xs text-ink-secondary">{item.note}</span>}
                </li>
              ))}
            </ul>
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

        {/* M2: the "approved, then live" proof. */}
        {cr.implemented_at && (
          <DetailRow label="Implemented">
            <span className="tabular-nums">
              Implemented on {formatDate(cr.implemented_at)}
              {cr.implemented_by_label ? ` by ${cr.implemented_by_label}` : ""}
            </span>
            {cr.implemented_note && cr.implemented_note.trim() !== "" && (
              <span className="mt-0.5 block whitespace-pre-wrap text-xs text-ink-secondary">{cr.implemented_note}</span>
            )}
          </DetailRow>
        )}

        {/* B1: decisions taken for this change request. */}
        {cr.decisions && cr.decisions.length > 0 && (
          <DetailRow label={`Decisions: ${cr.decisions.length}`}>
            <ul className="space-y-1">
              {cr.decisions.map((d) => (
                <li key={d.id}>
                  <a href={`/decisions?dec=${d.id}`} className="text-accent hover:underline">
                    {d.reference_id ? `${d.reference_id} ` : ""}
                    {d.title}
                  </a>
                </li>
              ))}
            </ul>
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
  /**
   * Called when the viewer chooses "Refresh" after a stale/already-decided
   * refusal. The inspector content is a frozen snapshot, so `router.refresh()`
   * alone never updates `expectedUpdatedAt`; callers must close the inspector
   * (the way DecisionFlow does) so reopening it loads the current record.
   */
  onRefresh?: () => void;
}

export function DecisionPanel({ crId, onDecided, decide, expectedUpdatedAt, onRefresh }: DecisionPanelProps) {
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
    // Approve's reason is optional; reject and defer always say why (Q-GOV-21).
    if (decision !== "approve" && !rationale.trim()) {
      setFieldErrors({ rationale: "Give a reason for rejecting or deferring." });
      focusRationale();
      return;
    }
    setError(null);
    setFieldErrors({});
    setSaving(true);

    try {
      await apiPost(`/api/change-requests/${crId}/decision`, {
        decision,
        ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
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
    <div className="mt-4 rounded-lg border border-border-subtle bg-well p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-3">
        Record Decision
      </h3>

      {refusal ? (
        <DecisionRefusal
          refusal={refusal}
          onBack={() => setRefusal(null)}
          onRefresh={() => {
            setRefusal(null);
            if (onRefresh) onRefresh();
            else router.refresh();
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
                        : "border-border-subtle bg-canvas text-ink-secondary hover:bg-well",
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

          <Field
            id={`${uid}-rationale`}
            label={decision === "approve" ? "Rationale" : "Rationale (required)"}
            optional={decision === "approve"}
            error={fieldErrors.rationale}
          >
            {(a11y) => (
              <TextareaInput
                {...a11y}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Explain the reasoning behind this decision…"
                rows={2}
                aria-required={decision === "approve" ? undefined : "true"}
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

// ── TransitionActions — start review / reopen a parked request ──────────────

/**
 * The two status moves that are not a decision. A manager or admin moves a raised
 * request to under review (Q-GOV-3); a deferred request is parked, not closed, and
 * its requester or a manager or admin reopens it (decision 24). The server decides
 * who sees each button (`canStartReview`, `canReopen`) and re-checks on the call.
 */
function TransitionActions({ cr, onDone }: { cr: ChangeRequest; onDone: () => void }) {
  const [busy, setBusy] = useState<"review" | "reopen" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "review" | "reopen") {
    setBusy(action);
    setError(null);
    try {
      await apiPost(`/api/change-requests/${cr.id}/${action}`);
      onDone();
    } catch (err) {
      setError((err as { message?: string })?.message || "Could not update the change request.");
      setBusy(null);
    }
  }

  const showReview = cr.status === "raised" && cr.canStartReview;
  const showReopen = cr.status === "deferred" && cr.canReopen;
  if (!showReview && !showReopen && cr.status !== "deferred") return null;

  return (
    <div className="mt-4 rounded-lg border border-border-subtle bg-well p-4">
      {cr.status === "deferred" && (
        <p className="mb-3 text-sm text-ink-secondary">
          Deferred means parked, not closed. {showReopen ? "Reopen it to put it back in review." : "Its requester, a manager or an admin can reopen it."}
        </p>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}
      {showReview && (
        <Button
          variant="secondary"
          size="sm"
          className="h-11 w-full sm:h-8 sm:w-auto"
          disabled={busy !== null}
          onClick={() => run("review")}
        >
          {busy === "review" ? <Spinner size="sm" className="mr-1.5" /> : null}
          Start review
        </Button>
      )}
      {showReopen && (
        <Button
          variant="primary"
          size="sm"
          className="h-11 w-full sm:h-8 sm:w-auto"
          disabled={busy !== null}
          onClick={() => run("reopen")}
        >
          {busy === "reopen" ? <Spinner size="sm" className="mr-1.5" /> : null}
          Reopen for review
        </Button>
      )}
    </div>
  );
}

// ── ImplementPanel — mark an approved request live (M2) ──────────────────────

/**
 * An approved request is marked implemented by its requester or a manager or
 * admin. The server decides who sees the button (`canImplement`) and re-checks on
 * the call; the stamp (date, person) and the audit row are one transaction.
 */
function ImplementPanel({ crId, onDone }: { crId: string; onDone: () => void }) {
  const uid = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/change-requests/${crId}/implement`, note.trim() ? { note: note.trim() } : {});
      onDone();
    } catch (err) {
      setError((err as { message?: string })?.message || "Could not mark the change request implemented.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border-subtle bg-well p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">Go live</h3>
      <p className="mb-3 text-sm text-ink-secondary">
        Mark it implemented once it is in place. The date and your name are recorded.
      </p>
      {error && <InlineAlert>{error}</InlineAlert>}
      <Field id={`${uid}-note`} label="Note" optional>
        {(a11y) => (
          <TextareaInput
            {...a11y}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Where or how it went live (optional)"
            rows={2}
          />
        )}
      </Field>
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          size="sm"
          className="h-11 w-full sm:h-8 sm:w-auto"
          disabled={busy}
          onClick={run}
        >
          {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
          Mark implemented
        </Button>
      </div>
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

  // The inspector holds a frozen snapshot of this record, so after a stale
  // (412) / already-decided refusal a refresh must close it: reopening loads
  // the current row (and its updated_at) instead of retrying with the old one.
  function handleRefreshRecord() {
    inspector.close();
    router.refresh();
  }

  // R-159: an emergency change commits on raise, so nothing waits for a decision on it.
  const canDecide = !decided && !isEmergencyChange(cr) && (cr.status === "raised" || cr.status === "under_review");

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 pb-3 border-b border-border-subtle mb-1">
        <div className="flex-1 min-w-0">
          {cr.reference_id && (
            <span className="font-mono text-2xs bg-well border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted mb-1 inline-block">
              {cr.reference_id}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {cr.title}
          </h2>
        </div>
        {cr.canEdit && !decided && (
          <Button variant="ghost" onClick={openEdit} className="shrink-0 h-11 px-3 text-xs sm:h-9">
            Edit
          </Button>
        )}
      </div>

      <ChangeFacts cr={cr} projectName={projectName} />

      {!decided && <TransitionActions cr={cr} onDone={handleDecided} />}

      {!decided && cr.status === "approved" && cr.canImplement && (
        <ImplementPanel crId={cr.id} onDone={handleDecided} />
      )}

      {/* Decision panel — only for actionable CRs */}
      {canDecide && (
        <DecisionPanel
          crId={cr.id}
          onDecided={handleDecided}
          decide={cr.decide}
          expectedUpdatedAt={cr.updated_at}
          onRefresh={handleRefreshRecord}
        />
      )}

      <EvidencePanel changeRequestId={cr.id} projectId={cr.project_id} referenceId={cr.reference_id} />
    </div>
  );
}

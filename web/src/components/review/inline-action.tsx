"use client";

/**
 * components/review/inline-action.tsx
 *
 * Inspector action cards rendered inside the right-push panel
 * for the "decide here" kinds in the Review Queue:
 *
 *   ApprovalInlineAction   — deletion_requests        (kind 'approval')
 *   ChangeInlineAction     — change_requests           (kind 'change')
 *   TimesheetInlineAction  — timesheet_submissions      (kind 'timesheet', L-31)
 *
 * Navigation kinds (risk / clash / document / rebaseline) continue
 * to deep-link and do NOT use these cards.
 *
 * Each card puts the record beside the decision (what is being deleted, who
 * asked, how big the change is) and offers Approve / Reject only when the
 * server says THIS viewer may decide (`item.decide`, see lib/review/four-eyes):
 * otherwise the four-eyes note says why, in place of the buttons.
 */

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { TextareaInput } from "@/components/forms/project-form";
import { DecisionPanel, ChangeFacts, statusLabel, type ChangeFactsData } from "@/components/change-control/change-detail";
import type { ChangeRequest } from "@/components/change-control/change-form";
import { DecisionRefusal } from "@/components/governance/decision-refusal";
import { CAN_DECIDE, FourEyesNote } from "@/components/governance/four-eyes-note";
import { describeRefusal, fieldMessages, type Refusal } from "@/components/governance/refusal";
import { Field, InlineAlert } from "@/components/integrations/shared";
import { apiPost } from "@/lib/api-client";
import type { ReviewItem } from "@/lib/review/gather";
import { cn } from "@/lib/cn";

// ── DetailRow ─────────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 border-b border-border-subtle last:border-0">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

function PendingFor({ days }: { days: number }) {
  return (
    <DetailRow label="Pending for">
      <span
        className={cn(
          "font-mono tabular-nums",
          days >= 14 ? "text-danger-ink" : days >= 7 ? "text-warning-ink" : "text-ink-muted",
        )}
      >
        {days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`}
      </span>
    </DetailRow>
  );
}

// ── DecisionFlow — pick, confirm, record (shared by deletions + timesheets) ───

type Choice = "approve" | "reject";

interface FlowLabels {
  confirmApprove: string;
  confirmReject: string;
  approveNotePlaceholder: string;
  /** Label of the reject field: "Reason" or "Rationale". */
  rejectField: string;
  rejectPlaceholder: string;
  /** Shown if the person submits an empty reject field. */
  rejectRequired: string;
  approved: string;
  rejected: string;
  /** What gets decided, for the buttons' accessible names. */
  subject: string;
}

/**
 * The two-step decision footer. Step 1 is a sticky bar of Approve / Reject
 * (>=44px, full width on phones); step 2 confirms, taking an optional note on
 * approve and a required reason on reject. A refusal that cannot succeed on
 * retry (four-eyes, already decided, locked…) replaces the form instead of
 * stacking above a still-enabled Confirm bar, and takes focus.
 */
function DecisionFlow({
  labels,
  submit,
}: {
  labels: FlowLabels;
  /** Performs the API call; throws on failure. `text` is the note (approve) or reason (reject). */
  submit: (choice: Choice, text: string) => Promise<void>;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const [confirming, setConfirming] = useState<Choice | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Focus follows the step (the button that was pressed is unmounted).
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) {
      formRef.current?.querySelector<HTMLElement>("textarea")?.focus();
    } else if (wasConfirming.current && !refusal) {
      rootRef.current?.querySelector<HTMLElement>("button")?.focus();
    }
    wasConfirming.current = confirming !== null;
  }, [confirming, refusal]);

  function reset() {
    setConfirming(null);
    setText("");
    setError(null);
    setRefusal(null);
    setFieldErrors({});
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirming) return;

    if (confirming === "reject" && !text.trim()) {
      setFieldErrors({ text: labels.rejectRequired });
      return;
    }

    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await submit(confirming, text.trim());
      toast.success(confirming === "approve" ? labels.approved : labels.rejected);
      inspector.close();
      router.refresh();
    } catch (err) {
      const found = describeRefusal(err, `Failed to ${confirming} ${labels.subject}.`);
      if (found.terminal) {
        setRefusal(found);
      } else {
        setError(found.detail);
        const fromApi = fieldMessages(err);
        setFieldErrors(Object.keys(fromApi).length > 0 ? { text: Object.values(fromApi)[0] } : {});
      }
      setSaving(false);
    }
  }

  const bar =
    "sticky bottom-0 -mx-4 -mb-4 mt-4 flex flex-col gap-2 border-t border-border-subtle bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row";

  return (
    // `contents`: this wrapper must not become the sticky bar's containing block, or the
    // footer would stop docking to the bottom of the inspector while its content scrolls.
    <div ref={rootRef} className="contents">
      {refusal && (
        <DecisionRefusal
          refusal={refusal}
          onBack={reset}
          onRefresh={() => {
            inspector.close();
            router.refresh();
          }}
        />
      )}

      {/* Step 1: pick action — docked at the bottom of the inspector sheet like
          a sticky footer (RightPushPanel's own footer slot isn't wired through
          useInspector, so this is a same-look sticky bar inside the panel's own
          scroll container). >=44px, full width on phones, primary first. */}
      {!refusal && !confirming && (
        <div className={bar}>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="h-11 w-full sm:h-9 sm:flex-1"
            aria-label={`Approve ${labels.subject}`}
            onClick={() => setConfirming("approve")}
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            className="h-11 w-full sm:h-9 sm:flex-1"
            aria-label={`Reject ${labels.subject}`}
            onClick={() => setConfirming("reject")}
          >
            Reject
          </Button>
        </div>
      )}

      {/* Step 2: confirm + note / reason */}
      {!refusal && confirming && (
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-3">
          {error && <InlineAlert>{error}</InlineAlert>}

          <div
            className={cn(
              "rounded-md border px-3 py-2.5 text-sm font-medium text-center",
              confirming === "approve"
                ? "border-success/30 bg-success/10 text-success-ink"
                : "border-danger/30 bg-danger/10 text-danger-ink",
            )}
          >
            {confirming === "approve" ? labels.confirmApprove : labels.confirmReject}
          </div>

          {confirming === "approve" ? (
            <Field id={`${uid}-text`} label="Note" optional>
              {(a11y) => (
                <TextareaInput
                  {...a11y}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={labels.approveNotePlaceholder}
                  rows={2}
                />
              )}
            </Field>
          ) : (
            <Field id={`${uid}-text`} label={`${labels.rejectField} (required)`} error={fieldErrors.text}>
              {(a11y) => (
                <TextareaInput
                  {...a11y}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={labels.rejectPlaceholder}
                  rows={3}
                  aria-required="true"
                />
              )}
            </Field>
          )}

          {/* flex-col-reverse on phones puts the primary Confirm action visually
              first (on top) without changing the Back-then-Confirm tab order. */}
          <div className={cn(bar, "flex-col-reverse")}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={reset}
              disabled={saving}
              className="h-11 w-full sm:h-9 sm:flex-1"
            >
              Back
            </Button>
            <Button
              type="submit"
              variant={confirming === "approve" ? "primary" : "danger"}
              size="sm"
              disabled={saving}
              className="h-11 w-full sm:h-9 sm:flex-1"
            >
              {saving ? (
                <>
                  <Spinner size="sm" className="mr-1.5" />
                  {confirming === "approve" ? "Approving…" : "Rejecting…"}
                </>
              ) : confirming === "approve" ? (
                "Confirm Approve"
              ) : (
                "Confirm Reject"
              )}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── ApprovalInlineAction ──────────────────────────────────────────────────────
// Approve/reject a deletion_request from within the queue inspector.

interface ApprovalInlineActionProps {
  item: ReviewItem;
}

export function ApprovalInlineAction({ item }: ApprovalInlineActionProps) {
  const decide = item.decide ?? CAN_DECIDE;
  const what = item.targetName ? `${item.targetType ?? "record"} “${item.targetName}”` : (item.targetType ?? "record");

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* The record being deleted */}
      <div className="mb-4">
        <div className="flex flex-wrap gap-2 mb-2">
          <Badge tone="danger">deletion request</Badge>
          {item.targetType && (
            <span className="text-sm font-medium text-ink capitalize">{item.targetType}</span>
          )}
        </div>
        <h2 className="mb-3 break-words text-base font-semibold leading-snug text-ink">
          {item.targetName ?? <span className="text-ink-muted">Name not recorded</span>}
        </h2>

        <div>
          {item.targetProject && (
            <DetailRow label="Project">
              <span>{item.targetProject}</span>
            </DetailRow>
          )}
          {item.requestedByLabel && (
            <DetailRow label="Requested By">
              <span className="font-medium">{item.requestedByLabel}</span>
            </DetailRow>
          )}
          {item.deletionReason && (
            <DetailRow label="Reason">
              <span className="text-ink-secondary">{item.deletionReason}</span>
            </DetailRow>
          )}
          <PendingFor days={item.ageDays} />
          {item.targetId && (
            <DetailRow label="Record ID">
              <code className="font-mono text-2xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-secondary break-all">
                {item.targetId}
              </code>
            </DetailRow>
          )}
        </div>
      </div>

      <FourEyesNote block={decide.canDecide ? null : decide.block} className="mb-1" />
      {!decide.canDecide && decide.canWithdraw && (
        <p className="mt-2 text-xs text-ink-secondary">
          You can withdraw it from{" "}
          <Link href="/approvals" className="focus-ring rounded-sm font-medium text-accent hover:underline">
            Approvals
          </Link>
          .
        </p>
      )}

      {decide.canDecide && (
        <DecisionFlow
          labels={{
            confirmApprove: "Confirm: Approve this deletion?",
            confirmReject: "Confirm: Reject this deletion request?",
            approveNotePlaceholder: "Any notes for the requester…",
            rejectField: "Reason",
            rejectPlaceholder: "Why are you rejecting this deletion request?",
            rejectRequired: "A reason is required when rejecting.",
            approved: "Deletion approved and committed.",
            rejected: "Deletion request rejected.",
            subject: `deletion of ${what}`,
          }}
          submit={async (choice, text) => {
            await apiPost(`/api/deletion-requests/${item.id}/${choice}`, {
              reason: choice === "reject" ? text : undefined,
              note: choice === "approve" && text ? text : undefined,
            });
          }}
        />
      )}
    </div>
  );
}

// ── ChangeInlineAction ────────────────────────────────────────────────────────
// Decide on a change_request from within the queue inspector.

interface ChangeInlineActionProps {
  item: ReviewItem;
}

export function ChangeInlineAction({ item }: ChangeInlineActionProps) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();
  const decide = item.decide ?? CAN_DECIDE;

  function handleDecided() {
    toast.success("Decision recorded.");
    inspector.close();
    router.refresh();
  }

  const c = item.change;
  const status = (item.crStatus ?? "under_review") as ChangeRequest["status"];
  // The same facts list the change-control inspector shows: who asked, when,
  // schedule/cost impact, description — the record beside the decision.
  const facts: ChangeFactsData = {
    status,
    priority: (c?.priority ?? "medium") as ChangeRequest["priority"],
    category: (c?.category ?? "other") as ChangeRequest["category"],
    requested_by_label: c?.requestedBy ?? null,
    raised_at: c?.raisedAt ?? "",
    target_date: c?.targetDate ?? null,
    impact_summary: c?.impactSummary ?? null,
    impact_schedule_days: c?.impactScheduleDays ?? null,
    impact_cost: c?.impactCost ?? null,
    description: c?.description ?? null,
  };

  return (
    <div className="flex flex-col gap-0 pb-4">
      <div className="mb-1 border-b border-border-subtle pb-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge tone="neutral" className="text-change-ink bg-change/10">change request</Badge>
          {c?.reference && (
            <span className="rounded bg-sunken border border-border-subtle px-1.5 py-0.5 font-mono text-2xs text-ink-muted">
              {c.reference}
            </span>
          )}
        </div>
        <h2 className="text-base font-semibold text-ink leading-snug">{item.title}</h2>
        <p className="mt-1 text-xs text-ink-muted">
          {statusLabel(status)} · pending {item.ageDays === 0 ? "since today" : `for ${item.ageDays} day${item.ageDays === 1 ? "" : "s"}`}
        </p>
      </div>

      <ChangeFacts cr={facts} projectName={item.project} />

      <Link
        href={item.href}
        className="focus-ring mt-2 inline-flex min-h-[44px] items-center self-start rounded-sm text-sm font-medium text-accent hover:underline sm:min-h-0"
      >
        Open the full record
      </Link>

      {/* Not allowed -> the note; allowed -> the rule, then the decision form. */}
      {decide.canDecide && <FourEyesNote className="mt-3" />}
      <DecisionPanel crId={item.id} onDecided={handleDecided} decide={decide} expectedUpdatedAt={c?.updatedAt} />
    </div>
  );
}

// ── TimesheetInlineAction ─────────────────────────────────────────────────────
// Approve/reject a timesheet_submissions row from within the queue inspector
// (L-31, four-eyes). Two-step confirm mirrors ApprovalInlineAction; rationale
// is required on reject (client-side gate, backed by the API's 422).

interface TimesheetInlineActionProps {
  item: ReviewItem;
}

export function TimesheetInlineAction({ item }: TimesheetInlineActionProps) {
  const decide = item.decide ?? CAN_DECIDE;

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* Submission metadata */}
      <div className="mb-4">
        <div className="flex flex-wrap gap-2 mb-3">
          <Badge tone="info">timesheet submission</Badge>
        </div>

        <div>
          {item.requestedByLabel && (
            <DetailRow label="Submitted By">
              <span className="font-medium">{item.requestedByLabel}</span>
            </DetailRow>
          )}
          {item.periodStart && (
            <DetailRow label="Week Of">
              <span className="font-mono">{item.periodStart}</span>
            </DetailRow>
          )}
          {item.hoursTotal !== undefined && (
            <DetailRow label="Hours">
              <span className="font-mono tabular-nums">{item.hoursTotal}</span>
            </DetailRow>
          )}
          <PendingFor days={item.ageDays} />
        </div>
      </div>

      <FourEyesNote block={decide.canDecide ? null : decide.block} verb="submitted" className="mb-1" />

      {decide.canDecide && (
        <DecisionFlow
          labels={{
            confirmApprove: "Confirm: Approve this timesheet?",
            confirmReject: "Confirm: Reject this timesheet?",
            approveNotePlaceholder: "Any notes for the submitter…",
            rejectField: "Rationale",
            rejectPlaceholder: "Why are you rejecting this timesheet?",
            rejectRequired: "A rationale is required when rejecting.",
            approved: "Timesheet approved.",
            rejected: "Timesheet rejected.",
            subject: "timesheet",
          }}
          submit={async (choice, text) => {
            await apiPost(`/api/timesheet-submissions/${item.id}/decision`, {
              decision: choice === "approve" ? "approved" : "rejected",
              rationale: text ? text : undefined,
            });
          }}
        />
      )}
    </div>
  );
}

"use client";

/**
 * components/review/inline-action.tsx
 *
 * Inspector action cards rendered inside the right-push panel
 * for the two "decide here" kinds in the Review Queue:
 *
 *   ApprovalInlineAction  — deletion_requests (kind 'approval')
 *   ChangeInlineAction    — change_requests   (kind 'change')
 *
 * Navigation kinds (risk / clash / document / rebaseline) continue
 * to deep-link and do NOT use these cards.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { FieldLabel, FieldError, TextareaInput } from "@/components/forms/project-form";
import { DecisionPanel } from "@/components/change-control/change-detail";
import { apiPost, type ApiError } from "@/lib/api-client";
import type { ReviewItem } from "@/lib/review/gather";
import { cn } from "@/lib/cn";

// ── DetailRow ─────────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 border-b border-border-subtle last:border-0">
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

// ── ApprovalInlineAction ──────────────────────────────────────────────────────
// Approve/reject a deletion_request from within the queue inspector.

interface ApprovalInlineActionProps {
  item: ReviewItem;
}

type ApprovalAction = "approve" | "reject";

export function ApprovalInlineAction({ item }: ApprovalInlineActionProps) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  // confirm step: null = initial, "approve" | "reject" = user picked one
  const [confirming, setConfirming] = useState<ApprovalAction | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [approveNote, setApproveNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function reset() {
    setConfirming(null);
    setRejectReason("");
    setApproveNote("");
    setError(null);
    setFieldErrors({});
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirming) return;

    // Client-side: reject requires a reason
    if (confirming === "reject" && !rejectReason.trim()) {
      setFieldErrors({ reason: "A reason is required when rejecting." });
      return;
    }

    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      await apiPost(`/api/deletion-requests/${item.id}/${confirming}`, {
        reason: confirming === "reject" ? rejectReason.trim() : undefined,
        note: confirming === "approve" && approveNote.trim() ? approveNote.trim() : undefined,
      });
      toast.success(
        confirming === "approve"
          ? "Deletion approved and committed."
          : "Deletion request rejected.",
      );
      inspector.close();
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message ?? `Failed to ${confirming} request.`);
      const map: Record<string, string> = {};
      for (const f of apiErr.fields ?? []) map[f.field] = f.message;
      setFieldErrors(map);
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* Request metadata */}
      <div className="mb-4">
        <div className="flex flex-wrap gap-2 mb-3">
          <Badge tone="danger">deletion request</Badge>
          {item.targetType && (
            <span className="text-sm font-medium text-ink capitalize">{item.targetType}</span>
          )}
        </div>

        <div>
          {item.targetId && (
            <DetailRow label="Target ID">
              <code className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-secondary">
                {item.targetId}
              </code>
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
          <DetailRow label="Pending for">
            <span className={cn(
              "font-mono tabular-nums",
              item.ageDays >= 14 ? "text-danger" : item.ageDays >= 7 ? "text-warning" : "text-ink-muted",
            )}>
              {item.ageDays === 0 ? "today" : item.ageDays === 1 ? "1 day" : `${item.ageDays} days`}
            </span>
          </DetailRow>
        </div>
      </div>

      {/* Four-eyes banner */}
      <div className="flex gap-2.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 mb-4">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 mt-0.5 text-warning">
          <path
            d="M8 1.5a6.5 6.5 0 1 0 0 13A6.5 6.5 0 0 0 8 1.5ZM7.25 4.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0v-3.5Zm.75 6.5a.875.875 0 1 1 0-1.75.875.875 0 0 1 0 1.75Z"
            fill="currentColor"
          />
        </svg>
        <p className="text-xs text-warning leading-snug">
          <span className="font-semibold">Four-eyes:</span> you must be a different person from the requester. Self-approval is blocked at the API layer.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger border border-danger/20">
          {error}
        </div>
      )}

      {/* Step 1: pick action */}
      {!confirming && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="flex-1"
            onClick={() => setConfirming("approve")}
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            className="flex-1"
            onClick={() => setConfirming("reject")}
          >
            Reject
          </Button>
        </div>
      )}

      {/* Step 2: confirm + reason */}
      {confirming && (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className={cn(
            "rounded-md border px-3 py-2.5 text-sm font-medium text-center",
            confirming === "approve"
              ? "border-success/30 bg-success/10 text-success"
              : "border-danger/30 bg-danger/10 text-danger",
          )}>
            {confirming === "approve" ? "Confirm: Approve this deletion?" : "Confirm: Reject this deletion request?"}
          </div>

          {/* Approve: optional note */}
          {confirming === "approve" && (
            <div>
              <FieldLabel>Note (optional)</FieldLabel>
              <TextareaInput
                value={approveNote}
                onChange={(e) => setApproveNote(e.target.value)}
                placeholder="Any notes for the requester…"
                rows={2}
              />
            </div>
          )}

          {/* Reject: required reason */}
          {confirming === "reject" && (
            <div>
              <FieldLabel>
                Reason <span className="text-danger ml-0.5">*</span>
              </FieldLabel>
              <TextareaInput
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Why are you rejecting this deletion request?"
                rows={3}
              />
              <FieldError message={fieldErrors.reason} />
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={reset}
              disabled={saving}
              className="flex-1"
            >
              Back
            </Button>
            <Button
              type="submit"
              variant={confirming === "approve" ? "primary" : "danger"}
              size="sm"
              disabled={saving}
              className="flex-1"
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

// ── ChangeInlineAction ────────────────────────────────────────────────────────
// Decide on a change_request from within the queue inspector.

interface ChangeInlineActionProps {
  item: ReviewItem;
}

export function ChangeInlineAction({ item }: ChangeInlineActionProps) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  function handleDecided() {
    toast.success("Decision recorded.");
    inspector.close();
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* CR metadata */}
      <div className="mb-3">
        <div className="flex flex-wrap gap-2 mb-2">
          <Badge tone="neutral" className="text-change bg-change/10">change request</Badge>
          {item.project && (
            <span className="rounded bg-sunken border border-border-subtle px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
              {item.project}
            </span>
          )}
        </div>

        <h2 className="text-base font-semibold text-ink leading-snug mb-3">{item.title}</h2>

        <div>
          <DetailRow label="Status">
            <Badge tone="info">{item.crStatus ?? "under_review"}</Badge>
          </DetailRow>
          <DetailRow label="Pending for">
            <span className={cn(
              "font-mono tabular-nums",
              item.ageDays >= 14 ? "text-danger" : item.ageDays >= 7 ? "text-warning" : "text-ink-muted",
            )}>
              {item.ageDays === 0 ? "today" : item.ageDays === 1 ? "1 day" : `${item.ageDays} days`}
            </span>
          </DetailRow>
        </div>
      </div>

      {/* Reuse DecisionPanel from change-detail */}
      <DecisionPanel crId={item.id} onDecided={handleDecided} />
    </div>
  );
}

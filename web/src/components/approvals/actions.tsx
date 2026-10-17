"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { FieldLabel, FieldError, TextareaInput } from "@/components/forms/project-form";
import { useToast } from "@/components/ui/toast";
import { apiPost, type ApiError } from "@/lib/api-client";
import { cn } from "@/lib/cn";

interface ApprovalActionsProps {
  requestId: string;
  /** The signed-in user is the original requester — four-eyes blocks their
   *  approve/reject, so offer withdrawal instead. */
  isOwn?: boolean;
}

type ConfirmStep = "approve" | "reject" | "withdraw";

export function ApprovalActions({ requestId, isOwn = false }: ApprovalActionsProps) {
  const router = useRouter();
  const toast = useToast();

  // null = pick action, "approve"|"reject" = confirm step
  const [confirming, setConfirming] = useState<ConfirmStep | null>(null);
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
      await apiPost(`/api/deletion-requests/${requestId}/${confirming}`, {
        reason: confirming === "reject" ? rejectReason.trim() : undefined,
        note:
          confirming === "approve" && approveNote.trim()
            ? approveNote.trim()
            : undefined,
      });
      toast.success(
        confirming === "approve"
          ? "Deletion approved and committed."
          : confirming === "reject"
            ? "Deletion request rejected."
            : "Deletion request withdrawn.",
      );
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
    <div className="flex flex-col gap-2">
      {/* Error banner */}
      {error && (
        <p className="text-xs text-danger-ink bg-danger/15 rounded-md px-3 py-2 border border-danger/20">
          {error}
        </p>
      )}

      {/* Step 1: pick action. Own requests get Withdraw only — four-eyes
          would 403/422 the maker's approve/reject anyway. Buttons are
          full-width and >=44px on phones (stacked in a column), the
          original inline/compact sizing returns at sm+. */}
      {!confirming && isOwn && (
        <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
          <Button
            variant="secondary"
            size="sm"
            className="h-11 w-full sm:h-8 sm:w-auto"
            onClick={() => setConfirming("withdraw")}
          >
            Withdraw
          </Button>
          <p className="text-xs text-ink-muted">Your request — a different person must decide it.</p>
        </div>
      )}
      {!confirming && !isOwn && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            variant="primary"
            size="sm"
            className="h-11 w-full sm:h-8 sm:w-auto"
            onClick={() => setConfirming("approve")}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="h-11 w-full sm:h-8 sm:w-auto"
            onClick={() => setConfirming("reject")}
          >
            Reject
          </Button>
        </div>
      )}

      {/* Step 2: confirm form */}
      {confirming && (
        <form onSubmit={handleSubmit} className="space-y-3 pt-1">
          {/* Confirmation label */}
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-xs font-medium",
              confirming === "approve"
                ? "border-success/30 bg-success/10 text-success-ink"
                : confirming === "reject"
                  ? "border-danger/30 bg-danger/10 text-danger-ink"
                  : "border-border-subtle bg-sunken text-ink-secondary",
            )}
          >
            {confirming === "approve"
              ? "Confirm: approve this deletion request?"
              : confirming === "reject"
                ? "Confirm: reject this deletion request?"
                : "Confirm: withdraw your deletion request?"}
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
                Reason{" "}
                <span className="text-danger-ink ml-0.5" aria-hidden>
                  *
                </span>
              </FieldLabel>
              <TextareaInput
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Why are you rejecting this deletion request?"
                rows={3}
                aria-required="true"
              />
              <FieldError message={fieldErrors.reason} />
            </div>
          )}

          {/* flex-col-reverse on phones puts the primary Confirm action
              visually first (on top) while keeping Back-then-Confirm tab
              order; both are >=44px and full width below sm. */}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={reset}
              disabled={saving}
              className="h-11 w-full sm:h-8 sm:w-auto"
            >
              Back
            </Button>
            <Button
              type="submit"
              variant={
                confirming === "approve"
                  ? "primary"
                  : confirming === "reject"
                    ? "danger"
                    : "secondary"
              }
              size="sm"
              disabled={saving}
              className="h-11 w-full sm:h-8 sm:w-auto"
            >
              {saving ? (
                <>
                  <Spinner size="sm" className="mr-1.5" />
                  {confirming === "approve"
                    ? "Approving…"
                    : confirming === "reject"
                      ? "Rejecting…"
                      : "Withdrawing…"}
                </>
              ) : confirming === "approve" ? (
                "Confirm Approve"
              ) : confirming === "reject" ? (
                "Confirm Reject"
              ) : (
                "Confirm Withdraw"
              )}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

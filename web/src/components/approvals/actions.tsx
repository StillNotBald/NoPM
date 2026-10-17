"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TextareaInput } from "@/components/forms/project-form";
import { useToast } from "@/components/ui/toast";
import { DecisionRefusal } from "@/components/governance/decision-refusal";
import { FourEyesNote, type DecideState } from "@/components/governance/four-eyes-note";
import { describeRefusal, fieldMessages, type Refusal } from "@/components/governance/refusal";
import { Field, InlineAlert } from "@/components/integrations/shared";
import { apiPost } from "@/lib/api-client";
import { cn } from "@/lib/cn";

interface ApprovalActionsProps {
  requestId: string;
  /**
   * Worked out on the server the way the API decides (see lib/review/four-eyes):
   * Approve / Reject are offered only when `canDecide`; otherwise the four-eyes
   * note takes their place, with Withdraw when the viewer raised it directly.
   */
  decide: DecideState;
  /** What is being decided, e.g. `task “Cutover plan”`; names the buttons for screen readers. */
  subject: string;
}

type ConfirmStep = "approve" | "reject" | "withdraw";

export function ApprovalActions({ requestId, decide, subject }: ApprovalActionsProps) {
  const router = useRouter();
  const toast = useToast();
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // null = pick action, otherwise the confirm step
  const [confirming, setConfirming] = useState<ConfirmStep | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [approveNote, setApproveNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Focus follows the step: into the confirm form, and back to the first action
  // button when the person steps back (the button they pressed was unmounted).
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) {
      formRef.current?.querySelector<HTMLElement>("textarea, button[type=submit]")?.focus();
    } else if (wasConfirming.current && !refusal) {
      rootRef.current?.querySelector<HTMLElement>("button")?.focus();
    }
    wasConfirming.current = confirming !== null;
  }, [confirming, refusal]);

  function reset() {
    setConfirming(null);
    setRejectReason("");
    setApproveNote("");
    setError(null);
    setRefusal(null);
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
      const found = describeRefusal(err, `Failed to ${confirming} request.`);
      if (found.terminal) {
        // Refused on principle (four-eyes, already decided, locked…): retrying the
        // same form can't work, so the message replaces it.
        setRefusal(found);
      } else {
        setError(found.detail);
        setFieldErrors(fieldMessages(err));
      }
      setSaving(false);
    }
  }

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      {refusal && (
        <DecisionRefusal
          refusal={refusal}
          onBack={reset}
          onRefresh={() => {
            reset();
            router.refresh();
          }}
        />
      )}

      {/* Step 1: pick action. Buttons are full-width and >=44px on phones
          (stacked in a column); the compact inline sizing returns at sm+. */}
      {!refusal && !confirming && decide.canDecide && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            variant="primary"
            size="sm"
            className="h-11 w-full sm:h-8 sm:w-auto"
            aria-label={`Approve deletion of ${subject}`}
            onClick={() => setConfirming("approve")}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="h-11 w-full sm:h-8 sm:w-auto"
            aria-label={`Reject deletion of ${subject}`}
            onClick={() => setConfirming("reject")}
          >
            Reject
          </Button>
        </div>
      )}

      {/* Can't decide: say why, in place of the buttons. Withdraw stays for the
          person who raised it directly. */}
      {!refusal && !confirming && !decide.canDecide && (
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <FourEyesNote block={decide.block} variant="inline" className="sm:ml-auto sm:max-w-[16rem] sm:text-right" />
          {decide.canWithdraw && (
            <Button
              variant="secondary"
              size="sm"
              className="h-11 w-full sm:h-8 sm:w-auto"
              aria-label={`Withdraw your request to delete ${subject}`}
              onClick={() => setConfirming("withdraw")}
            >
              Withdraw
            </Button>
          )}
        </div>
      )}

      {/* Step 2: confirm form */}
      {!refusal && confirming && (
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-3 pt-1">
          {error && <InlineAlert>{error}</InlineAlert>}

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
            <Field id={`${uid}-note`} label="Note" optional>
              {(a11y) => (
                <TextareaInput
                  {...a11y}
                  value={approveNote}
                  onChange={(e) => setApproveNote(e.target.value)}
                  placeholder="Any notes for the requester…"
                  rows={2}
                />
              )}
            </Field>
          )}

          {/* Reject: required reason */}
          {confirming === "reject" && (
            <Field id={`${uid}-reason`} label="Reason (required)" error={fieldErrors.reason}>
              {(a11y) => (
                <TextareaInput
                  {...a11y}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Why are you rejecting this deletion request?"
                  rows={3}
                  aria-required="true"
                />
              )}
            </Field>
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

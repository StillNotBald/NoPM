"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/ui/modal";
import { TextareaInput } from "@/components/forms/project-form";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, type ApiError } from "@/lib/api-client";

type TimesheetStatus = "submitted" | "approved" | "rejected" | null;

const STATUS_BADGE: Record<Exclude<TimesheetStatus, null>, { tone: "info" | "success" | "danger"; label: string }> = {
  submitted: { tone: "info", label: "Submitted — pending decision" },
  approved: { tone: "success", label: "Approved" },
  rejected: { tone: "danger", label: "Rejected — resubmit to try again" },
};

/**
 * TimesheetSubmitPanel (L-31) — the submit button + status badge for the
 * selected member+week on /timesheets. Decisions (approve/reject) happen in
 * the Review Queue (components/review/inline-action.tsx TimesheetInlineAction);
 * this panel is submit-only, mirroring the maker/checker split.
 */
export function TimesheetSubmitPanel({
  memberId,
  periodStart,
  canWrite,
  initialStatus,
  reopened = false,
  submissionId = null,
  canReopen = false,
}: {
  memberId: string | null;
  periodStart: string;
  canWrite: boolean;
  initialStatus: TimesheetStatus;
  /** The sheet was reopened for amendment: still "submitted", but its entries can be edited. */
  reopened?: boolean;
  /** Latest submission for this member+week; needed to reopen it. */
  submissionId?: string | null;
  /** D-16: only admins and managers may reopen (decide) a sheet. */
  canReopen?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [status, setStatus] = useState<TimesheetStatus>(initialStatus);
  const [busy, setBusy] = useState(false);
  const modal = useModal();

  if (!memberId) return null;

  // Submit also resubmits: after a rejection, or on a reopened (amendable) sheet.
  const canSubmitAgain = status === "rejected" || (status === "submitted" && reopened);

  if (status && !(canSubmitAgain && canWrite)) {
    const meta =
      status === "submitted" && reopened
        ? { tone: "info" as const, label: "Reopened — open for amendment" }
        : STATUS_BADGE[status];
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {status === "approved" && (
          // L-32/R-76: the period-close lock — an approved week's time
          // entries can't be created/deleted until a reopen decision is
          // recorded (POST /timesheet-submissions/{id}/decision, "reopened").
          <span className="text-xs text-ink-muted">— week locked</span>
        )}
        {/* R-7: the API only reopens an APPROVED sheet (assertReopenable). */}
        {status === "approved" && submissionId && (
          canReopen ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-11 sm:h-9"
              onClick={() =>
                modal.open(
                  <ReopenDialog
                    submissionId={submissionId}
                    onCancel={() => modal.close()}
                    onDone={() => {
                      modal.close();
                      toast.success("Timesheet reopened for amendment.");
                      router.refresh();
                    }}
                  />,
                  { title: "Reopen timesheet", size: "sm" },
                )
              }
            >
              Reopen
            </Button>
          ) : (
            <span className="text-xs text-ink-muted" title="Only managers and admins can approve or reopen">
              Only managers and admins can reopen
            </span>
          )
        )}
      </span>
    );
  }

  if (!canWrite) return null;

  async function submit() {
    setBusy(true);
    try {
      await apiPost("/api/timesheet-submissions", { member_id: memberId, period_start: periodStart });
      toast.success("Timesheet submitted for approval.");
      setStatus("submitted");
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      toast.error(apiErr.message ?? "Failed to submit timesheet.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {status && (
        <Badge tone={status === "rejected" ? "danger" : "info"}>
          {status === "rejected" ? STATUS_BADGE.rejected.label : "Reopened — open for amendment"}
        </Badge>
      )}
      <Button type="button" variant="secondary" size="sm" onClick={submit} disabled={busy} className="h-11 sm:h-9 shrink-0">
        {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
        {status ? "Resubmit timesheet" : "Submit timesheet"}
      </Button>
    </span>
  );
}

function ReopenDialog({
  submissionId,
  onCancel,
  onDone,
}: {
  submissionId: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!rationale.trim()) {
      setError("A reason is required to reopen a timesheet.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/timesheet-submissions/${submissionId}/decision`, {
        decision: "reopened",
        rationale: rationale.trim(),
      });
      onDone();
    } catch (err) {
      setError((err as ApiError).message ?? "Failed to reopen timesheet.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        Reopening unlocks the week so the member can amend their entries and resubmit. The reason is recorded on the audit trail.
      </p>
      <TextareaInput
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        rows={3}
        placeholder="Why is this timesheet being reopened?"
        disabled={busy}
        aria-required="true"
      />
      {error && <p role="alert" className="text-xs text-danger-ink">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" onClick={go} disabled={busy}>
          {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
          Reopen
        </Button>
      </div>
    </div>
  );
}

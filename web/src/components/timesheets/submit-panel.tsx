"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
}: {
  memberId: string | null;
  periodStart: string;
  canWrite: boolean;
  initialStatus: TimesheetStatus;
  /** The sheet was reopened for amendment: still "submitted", but its entries can be edited. */
  reopened?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [status, setStatus] = useState<TimesheetStatus>(initialStatus);
  const [busy, setBusy] = useState(false);

  if (!memberId) return null;

  if (status) {
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
    <Button type="button" variant="secondary" size="sm" onClick={submit} disabled={busy} className="h-11 sm:h-9 shrink-0">
      {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
      Submit timesheet
    </Button>
  );
}

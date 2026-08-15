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
}: {
  memberId: string | null;
  periodStart: string;
  canWrite: boolean;
  initialStatus: TimesheetStatus;
}) {
  const router = useRouter();
  const toast = useToast();
  const [status, setStatus] = useState<TimesheetStatus>(initialStatus);
  const [busy, setBusy] = useState(false);

  if (!memberId) return null;

  if (status) {
    const meta = STATUS_BADGE[status];
    return (
      <Badge tone={meta.tone} className="shrink-0">
        {meta.label}
      </Badge>
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

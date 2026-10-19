"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, type ApiError } from "@/lib/api-client";
import { RequestDeletionControl } from "@/components/governance/request-deletion";

type SprintState = "planned" | "active" | "closed";

/**
 * Governed planned -> active -> closed transition buttons for the selected
 * sprint's detail card (L-17/18). Each call hits the exact T1 route — no
 * client-side state math, the server snapshot is the only source of truth.
 */
export function SprintTransitionActions({
  sprintId,
  state,
  hasAttachedTasks,
  unfinishedCount = 0,
  moveTargets = [],
}: {
  sprintId: string;
  state: SprintState;
  hasAttachedTasks: boolean;
  /** Attached tasks that are not completed/canceled (Q-WRK-20). */
  unfinishedCount?: number;
  /** Other planned/active sprints of the same project the unfinished tasks may move to. */
  moveTargets?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"start" | "close" | null>(null);
  // Q-WRK-20: closing asks where the unfinished tasks go.
  const [asking, setAsking] = useState(false);
  const [destination, setDestination] = useState("backlog");

  async function run(action: "start" | "close") {
    if (action === "close" && unfinishedCount > 0 && !asking) {
      setAsking(true);
      return;
    }
    setBusy(action);
    try {
      if (action === "start") {
        await apiPost(`/api/sprints/${sprintId}/start`);
        toast.success("Sprint started");
      } else {
        await apiPost(
          `/api/sprints/${sprintId}/close`,
          unfinishedCount > 0 ? { move_unfinished_to: destination } : undefined,
        );
        toast.success("Sprint closed");
      }
      router.refresh();
    } catch (err) {
      toast.error((err as ApiError).message ?? "Action failed");
    } finally {
      setBusy(null);
    }
  }

  if (state === "closed") {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state === "planned" && (
        <>
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== null}
            onClick={() => run("start")}
          >
            {busy === "start" ? <Spinner size="sm" className="mr-1.5" /> : null}
            Start Sprint
          </Button>
          {hasAttachedTasks ? (
            <Button variant="ghost" size="sm" disabled title="Detach all tasks before requesting deletion">
              Request deletion
            </Button>
          ) : (
            // R-177: a sprint is deleted only after a different person approves the request.
            <RequestDeletionControl
              entity="sprint"
              id={sprintId}
              consequence="Only a planned sprint with no tasks can be deleted."
            />
          )}
        </>
      )}
      {state === "active" && asking && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Where do the unfinished tasks go?">
          <label className="text-xs text-ink-muted" htmlFor="sprint-move-unfinished">
            {unfinishedCount} unfinished {unfinishedCount === 1 ? "task" : "tasks"} go to
          </label>
          <select
            id="sprint-move-unfinished"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            className="focus-ring h-11 rounded-md border border-border bg-surface px-2 text-sm text-ink sm:h-9"
          >
            <option value="backlog">Backlog (no sprint)</option>
            {moveTargets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => run("close")}>
            {busy === "close" ? <Spinner size="sm" className="mr-1.5" /> : null}
            Close sprint
          </Button>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      )}
      {state === "active" && !asking && (
        <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => run("close")}>
          {busy === "close" ? <Spinner size="sm" className="mr-1.5" /> : null}
          Close Sprint
        </Button>
      )}
    </div>
  );
}

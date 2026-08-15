"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiDelete, type ApiError } from "@/lib/api-client";

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
}: {
  sprintId: string;
  state: SprintState;
  hasAttachedTasks: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"start" | "close" | "delete" | null>(null);

  async function run(action: "start" | "close" | "delete") {
    setBusy(action);
    try {
      if (action === "start") {
        await apiPost(`/api/sprints/${sprintId}/start`);
        toast.success("Sprint started");
      } else if (action === "close") {
        await apiPost(`/api/sprints/${sprintId}/close`);
        toast.success("Sprint closed");
      } else {
        await apiDelete(`/api/sprints/${sprintId}`);
        toast.success("Sprint deleted");
        router.push("/sprints");
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
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null || hasAttachedTasks}
            title={hasAttachedTasks ? "Detach all tasks before deleting" : undefined}
            onClick={() => run("delete")}
          >
            {busy === "delete" ? <Spinner size="sm" className="mr-1.5" /> : null}
            Delete
          </Button>
        </>
      )}
      {state === "active" && (
        <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => run("close")}>
          {busy === "close" ? <Spinner size="sm" className="mr-1.5" /> : null}
          Close Sprint
        </Button>
      )}
    </div>
  );
}

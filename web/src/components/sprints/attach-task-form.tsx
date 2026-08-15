"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { SelectInput } from "@/components/forms/project-form";
import { apiGet, apiPost, apiDelete, type ApiError } from "@/lib/api-client";

interface TaskOption {
  id: string;
  name: string;
  sprint_id: string | null;
}

/**
 * Attach/detach tasks on the selected sprint (L-17). Picker lists this
 * sprint's own project tasks that aren't already attached to THIS sprint —
 * a task can only ever belong to 0..1 sprint, so attaching here silently
 * moves it out of whatever sprint it was in before (same as the API).
 * Closed sprints never render this (caller gates on `state !== 'closed'`).
 */
export function AttachTaskForm({
  sprintId,
  projectId,
  attachedTasks,
}: {
  sprintId: string;
  projectId: string;
  attachedTasks: { id: string; name: string }[];
}) {
  const router = useRouter();
  const toast = useToast();

  const [options, setOptions] = useState<TaskOption[]>([]);
  const [taskId, setTaskId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    apiGet<TaskOption[]>(`/api/tasks?project_id=${projectId}&limit=100`)
      .then((list) => setOptions((list ?? []).filter((t) => t.sprint_id !== sprintId)))
      .catch(() => {
        /* non-critical — picker just stays empty */
      });
  }, [projectId, sprintId]);

  async function attach() {
    if (!taskId) return;
    setBusy("attach");
    try {
      await apiPost(`/api/sprints/${sprintId}/tasks`, { task_id: taskId });
      toast.success("Task attached");
      setTaskId("");
      router.refresh();
    } catch (err) {
      toast.error((err as ApiError).message ?? "Failed to attach task");
    } finally {
      setBusy(null);
    }
  }

  async function detach(id: string) {
    setBusy(id);
    try {
      await apiDelete(`/api/sprints/${sprintId}/tasks?task_id=${id}`);
      toast.success("Task detached");
      router.refresh();
    } catch (err) {
      toast.error((err as ApiError).message ?? "Failed to detach task");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SelectInput value={taskId} onChange={(e) => setTaskId(e.target.value)} className="sm:max-w-xs">
          <option value="">— Select a task to attach —</option>
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectInput>
        <Button
          variant="secondary"
          size="sm"
          disabled={!taskId || busy !== null}
          onClick={attach}
          className="h-11 sm:h-9"
        >
          {busy === "attach" ? <Spinner size="sm" className="mr-1.5" /> : null}
          Attach
        </Button>
      </div>

      {attachedTasks.length > 0 && (
        <ul className="space-y-1">
          {attachedTasks.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-2 text-sm"
            >
              <span className="truncate text-ink">{t.name}</span>
              <button
                type="button"
                onClick={() => detach(t.id)}
                disabled={busy !== null}
                aria-label={`Detach ${t.name}`}
                className="shrink-0 rounded p-1 text-ink-muted hover:bg-sunken hover:text-ink disabled:opacity-50"
              >
                {busy === t.id ? <Spinner size="sm" /> : <X size={14} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

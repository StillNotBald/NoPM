"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { FieldLabel, FieldError, SelectInput, TextareaInput } from "@/components/forms/project-form";

// ── Data shapes ───────────────────────────────────────────────────────────────

export interface Milestone {
  id: string;
  project_id: string;
  name: string;
  target_date: string | null;
  status: "not_started" | "on_track" | "at_risk" | "delayed" | "completed";
  completion_pct: number;
  owner_id: string | null;
  sort_order: number;
}

export interface Task {
  id: string;
  project_id: string;
  milestone_id: string | null;
  name: string;
  description: string | null;
  status: string;
  status_type: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  priority: "low" | "medium" | "high" | "urgent";
  start_date: string | null;
  due_date: string | null;
  completion_pct: number;
  sort_order: number;
  assignee_id: string | null;
  // ── content-enrichment (0008) — additive, all optional/nullable ──────────────
  acceptance_criteria?: string | null;
  estimate_hours?: number | null;
  story_points?: number | null;
  labels?: string[] | null;
  blocked_by?: string | null;
}

// ── TaskForm ──────────────────────────────────────────────────────────────────

export function TaskForm({
  projectId,
  milestoneId,
  task,
  milestones,
  tasks = [],
}: {
  projectId: string;
  milestoneId?: string | null;
  task?: Task;
  milestones: Milestone[];
  /** Sibling tasks in the project — populates the "Blocked by" dependency select. */
  tasks?: Task[];
}) {
  const inspector = useInspector();
  const router = useRouter();

  const [name, setName] = useState(task?.name ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [showDescription, setShowDescription] = useState(
    !!(task?.description && task.description.trim().length > 0)
  );
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string>(
    task?.milestone_id ?? milestoneId ?? ""
  );
  const [priority, setPriority] = useState<Task["priority"]>(
    task?.priority ?? "medium"
  );
  const [statusType, setStatusType] = useState<Task["status_type"]>(
    task?.status_type ?? "unstarted"
  );
  const [startDate, setStartDate] = useState(task?.start_date?.slice(0, 10) ?? "");
  const [dueDate, setDueDate] = useState(task?.due_date?.slice(0, 10) ?? "");
  const [completionPct, setCompletionPct] = useState(task?.completion_pct ?? 0);

  // ── content-enrichment (0008) fields — all optional ──────────────────────────
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    task?.acceptance_criteria ?? ""
  );
  const [estimateHours, setEstimateHours] = useState(
    task?.estimate_hours != null ? String(task.estimate_hours) : ""
  );
  const [storyPoints, setStoryPoints] = useState(
    task?.story_points != null ? String(task.story_points) : ""
  );
  const [labels, setLabels] = useState((task?.labels ?? []).join(", "));
  const [blockedBy, setBlockedBy] = useState(task?.blocked_by ?? "");

  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function applyApiError(err: ApiError) {
    setTopError(err.message ?? "An error occurred.");
    const map: Record<string, string> = {};
    for (const f of err.fields ?? []) map[f.field] = f.message;
    setFieldErrors(map);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);
    setFieldErrors({});
    setSaving(true);

    const parsedLabels = labels
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      milestone_id: selectedMilestoneId || null,
      priority,
      status_type: statusType,
      start_date: startDate || null,
      due_date: dueDate || null,
      completion_pct: Number(completionPct),
      acceptance_criteria: acceptanceCriteria.trim() || null,
      estimate_hours: estimateHours.trim() === "" ? null : Number(estimateHours),
      story_points: storyPoints.trim() === "" ? null : Number(storyPoints),
      labels: parsedLabels,
      blocked_by: blockedBy || null,
    };

    try {
      if (task) {
        await apiPatch(`/api/tasks/${task.id}`, payload);
      } else {
        await apiPost(`/api/projects/${projectId}/tasks`, payload);
      }
      router.refresh();
      inspector.close();
    } catch (err) {
      applyApiError(err as ApiError);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {topError && (
        <div className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger">
          {topError}
        </div>
      )}

      {/* Title — prominent */}
      <div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Task name"
          required
          className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
        />
        <FieldError message={fieldErrors.name} />
      </div>

      {/* Compact properties grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1">
        {/* Milestone */}
        <div>
          <FieldLabel>Milestone</FieldLabel>
          <SelectInput
            value={selectedMilestoneId}
            onChange={(e) => setSelectedMilestoneId(e.target.value)}
          >
            <option value="">— None —</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </SelectInput>
          <FieldError message={fieldErrors.milestone_id} />
        </div>

        {/* Priority */}
        <div>
          <FieldLabel>Priority</FieldLabel>
          <SelectInput
            value={priority}
            onChange={(e) => setPriority(e.target.value as Task["priority"])}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </SelectInput>
          <FieldError message={fieldErrors.priority} />
        </div>

        {/* Status */}
        <div>
          <FieldLabel>Status</FieldLabel>
          <SelectInput
            value={statusType}
            onChange={(e) => setStatusType(e.target.value as Task["status_type"])}
          >
            <option value="backlog">Backlog</option>
            <option value="unstarted">To do</option>
            <option value="started">In progress</option>
            <option value="completed">Completed</option>
            <option value="canceled">Canceled</option>
          </SelectInput>
          <FieldError message={fieldErrors.status_type} />
        </div>

        {/* Completion % */}
        <div>
          <FieldLabel>Completion %</FieldLabel>
          <Input
            type="number"
            min={0}
            max={100}
            value={completionPct}
            onChange={(e) => setCompletionPct(Number(e.target.value))}
            placeholder="0"
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.completion_pct} />
        </div>

        {/* Start Date */}
        <div>
          <FieldLabel>Start Date</FieldLabel>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.start_date} />
        </div>

        {/* Due Date */}
        <div>
          <FieldLabel>Due Date</FieldLabel>
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.due_date} />
        </div>

        {/* Estimate (hours) */}
        <div>
          <FieldLabel>Estimate (hours)</FieldLabel>
          <Input
            type="number"
            min={0}
            step={0.25}
            value={estimateHours}
            onChange={(e) => setEstimateHours(e.target.value)}
            placeholder="e.g. 8"
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.estimate_hours} />
        </div>

        {/* Story Points */}
        <div>
          <FieldLabel>Story Points</FieldLabel>
          <Input
            type="number"
            min={0}
            step={0.5}
            value={storyPoints}
            onChange={(e) => setStoryPoints(e.target.value)}
            placeholder="e.g. 3"
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.story_points} />
        </div>

        {/* Blocked by */}
        <div>
          <FieldLabel>Blocked by</FieldLabel>
          <SelectInput
            value={blockedBy}
            onChange={(e) => setBlockedBy(e.target.value)}
          >
            <option value="">— None —</option>
            {tasks
              .filter((t) => t.id !== task?.id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </SelectInput>
          <FieldError message={fieldErrors.blocked_by} />
        </div>

        {/* Labels */}
        <div>
          <FieldLabel>Labels</FieldLabel>
          <Input
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="comma, separated, tags"
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.labels} />
        </div>
      </div>

      {/* Description — progressive disclosure */}
      {showDescription ? (
        <div>
          <FieldLabel>Description</FieldLabel>
          <TextareaInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional details…"
            rows={3}
          />
          <FieldError message={fieldErrors.description} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowDescription(true)}
          className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
        >
          + Add description
        </button>
      )}

      {/* Acceptance criteria — definition of done */}
      <div>
        <FieldLabel>Acceptance Criteria</FieldLabel>
        <TextareaInput
          value={acceptanceCriteria}
          onChange={(e) => setAcceptanceCriteria(e.target.value)}
          placeholder="Definition of done — what must be true for this task to be accepted?"
          rows={3}
        />
        <FieldError message={fieldErrors.acceptance_criteria} />
      </div>

      {/* Actions */}
      <div className="flex flex-col-reverse gap-2 border-t border-border-subtle pt-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={inspector.close} disabled={saving} className="w-full sm:w-auto h-11 sm:h-10">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !name.trim()} className="w-full sm:w-auto h-11 sm:h-10">
          {saving ? (
            <>
              <Spinner size="sm" className="mr-2" />
              Saving…
            </>
          ) : task ? (
            "Save Changes"
          ) : (
            "Add Task"
          )}
        </Button>
      </div>
    </form>
  );
}

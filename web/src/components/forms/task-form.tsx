"use client";

import { useState, useEffect, useId } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiGet, apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { Field, FieldLabel, FormError, TitleField, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";
import { BackupOwnerField, useBackupOwner } from "@/components/forms/backup-owner-field";
import type { ChecklistItem } from "@/app/api/tasks/_schema";
import { validateFields } from "@/lib/forms/validate";

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
  /** M6: a resource member who picks this task up if the assignee is away. */
  backup_assignee_id?: string | null;
  // ── content-enrichment (0008) — additive, all optional/nullable ──────────────
  acceptance_criteria?: string | null;
  estimate_hours?: number | null;
  story_points?: number | null;
  labels?: string[] | null;
  blocked_by?: string | null;
  /** R-166 (0111): why the task is blocked (max 500 characters). */
  blocker_reason?: string | null;
  /** R-166 (0111): forecast finish date, YYYY-MM-DD. */
  eta?: string | null;
  checklist?: ChecklistItem[] | null;
  // Optimistic concurrency (R-90) — present on any record loaded from the
  // API; carried back on PATCH as expected_updated_at when editing.
  updated_at?: string | null;
}

/** Lightweight shape returned by GET /api/resources */
interface WorkspaceMember {
  id: string;
  name: string;
  role_title?: string | null;
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
  const toast = useToast();

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
  const [blockerReason, setBlockerReason] = useState(task?.blocker_reason ?? "");
  const [eta, setEta] = useState(task?.eta?.slice(0, 10) ?? "");

  // ── assignee picker ──────────────────────────────────────────────────────────
  const [assigneeId, setAssigneeId] = useState(task?.assignee_id ?? "");
  const [members, setMembers] = useState<WorkspaceMember[]>([]);

  useEffect(() => {
    apiGet<{ items?: WorkspaceMember[]; data?: WorkspaceMember[] }>("/api/resources?limit=100")
      .then((res) => {
        const list = (res as unknown as { items?: WorkspaceMember[]; data?: WorkspaceMember[] });
        setMembers(list.items ?? list.data ?? []);
      })
      .catch(() => {/* non-critical — picker just stays empty */});
  }, []);

  // ── checklist ────────────────────────────────────────────────────────────────
  const [checklist, setChecklist] = useState<ChecklistItem[]>(
    task?.checklist ?? []
  );
  const [newItemText, setNewItemText] = useState("");
  const checklistLabelId = useId();

  function addChecklistItem() {
    const text = newItemText.trim();
    if (!text) return;
    setChecklist((prev) => [
      ...prev,
      { id: crypto.randomUUID(), text, done: false },
    ]);
    setNewItemText("");
  }

  function toggleChecklistItem(id: string) {
    setChecklist((prev) =>
      prev.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
    );
  }

  function removeChecklistItem(id: string) {
    setChecklist((prev) => prev.filter((item) => item.id !== id));
  }

  const backup = useBackupOwner("tasks", task?.id, task?.backup_assignee_id);
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

    // Client-side validation — immediate feedback before the network round-trip.
    const clientResult = validateFields([
      { key: "name", value: name.trim(), message: "Task name is required" },
    ]);
    if (!clientResult.ok) {
      setFieldErrors(clientResult.errors);
      return;
    }

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
      assignee_id: assigneeId || null,
      acceptance_criteria: acceptanceCriteria.trim() || null,
      estimate_hours: estimateHours.trim() === "" ? null : Number(estimateHours),
      story_points: storyPoints.trim() === "" ? null : Number(storyPoints),
      labels: parsedLabels,
      blocked_by: blockedBy || null,
      blocker_reason: blockerReason.trim() || null,
      eta: eta || null,
      checklist: checklist.length > 0 ? checklist : null,
      ...backup.payload(Boolean(task)),
      // Optimistic concurrency (R-90) — only meaningful (and only sent) on
      // an edit of an existing record; a create has nothing to be stale.
      ...(task?.updated_at ? { expected_updated_at: task.updated_at } : {}),
    };

    try {
      if (task) {
        await apiPatch(`/api/tasks/${task.id}`, payload);
        // If blocked_by changed, wire the dependency row.
        // We do not remove the old dep here (non-destructive on update) —
        // the POST endpoint rejects duplicates gracefully.
        if (blockedBy && blockedBy !== task.blocked_by) {
          try {
            await apiPost(`/api/tasks/${task.id}/dependencies`, {
              predecessor_id: blockedBy,
            });
          } catch {
            // Non-fatal: duplicate or circular — dependency UI shows the reason.
          }
        }
      } else {
        const newTask = await apiPost<{ id: string }>(
          `/api/projects/${projectId}/tasks`,
          payload,
        );
        // Wire the blocked-by dependency once we have a real task id.
        if (blockedBy && newTask?.id) {
          try {
            await apiPost(`/api/tasks/${newTask.id}/dependencies`, {
              predecessor_id: blockedBy,
            });
          } catch {
            // Non-fatal: error surfaced separately if needed.
          }
        }
      }
      toast.success(task ? "Task updated" : "Task created");
      router.refresh();
      inspector.close();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 412) {
        setTopError("This record changed since you opened it. Reload to see the latest.");
        toast.error("This record changed since you opened it. Reload to see the latest.");
      } else {
        applyApiError(apiErr);
        toast.error(apiErr.message ?? "Failed to save task");
      }
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <FormError message={topError} />

      {/* Title — prominent */}
      <TitleField
        label="Task name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Task name"
        required
        error={fieldErrors.name}
      />

      {/* Section: Status & Schedule */}
      <FormSection title="Status & Schedule">
        <FormGrid>
          {/* Status */}
          <Field label="Status" error={fieldErrors.status_type}>
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
          </Field>

          {/* Priority */}
          <Field label="Priority" error={fieldErrors.priority}>
            <SelectInput
              value={priority}
              onChange={(e) => setPriority(e.target.value as Task["priority"])}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </SelectInput>
          </Field>

          {/* Milestone */}
          <Field label="Milestone" error={fieldErrors.milestone_id}>
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
          </Field>

          {/* Completion % */}
          <Field label="Completion %" error={fieldErrors.completion_pct}>
            <Input
              type="number"
              min={0}
              max={100}
              value={completionPct}
              onChange={(e) => setCompletionPct(Number(e.target.value))}
              placeholder="0"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Start Date */}
          <Field label="Start Date" error={fieldErrors.start_date}>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Due Date */}
          <Field label="Due Date" error={fieldErrors.due_date}>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>
        </FormGrid>
      </FormSection>

      {/* Section: Estimation */}
      <FormSection title="Estimation">
        <FormGrid>
          {/* Estimate (hours) */}
          <Field label="Estimate (hours)" error={fieldErrors.estimate_hours}>
            <Input
              type="number"
              min={0}
              step={0.25}
              value={estimateHours}
              onChange={(e) => setEstimateHours(e.target.value)}
              placeholder="e.g. 8"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Story Points */}
          <Field label="Story Points" error={fieldErrors.story_points}>
            <Input
              type="number"
              min={0}
              step={0.5}
              value={storyPoints}
              onChange={(e) => setStoryPoints(e.target.value)}
              placeholder="e.g. 3"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>
        </FormGrid>
      </FormSection>

      {/* Section: Assignment */}
      <FormSection title="Assignment">
        <FormGrid>
          {/* Assignee */}
          <Field label="Assignee" error={fieldErrors.assignee_id}>
            <SelectInput
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
            >
              <option value="">— Unassigned —</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.role_title ? ` (${m.role_title})` : ""}
                </option>
              ))}
            </SelectInput>
          </Field>

          {/* Backup assignee (M6) */}
          <BackupOwnerField state={backup} label="Backup assignee" error={fieldErrors.backup_assignee_id} />

          {/* Blocked by */}
          <Field label="Blocked by" error={fieldErrors.blocked_by}>
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
          </Field>

          {/* Blocker reason (R-166): optional, independent of "Blocked by" */}
          <Field label="Blocker reason" error={fieldErrors.blocker_reason}>
            <TextareaInput
              value={blockerReason}
              onChange={(e) => setBlockerReason(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Why is this blocked? (optional)"
            />
          </Field>

          {/* ETA (R-166): optional forecast date, may be in the past */}
          <Field label="ETA" error={fieldErrors.eta}>
            <Input
              type="date"
              value={eta}
              onChange={(e) => setEta(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Labels */}
          <Field label="Labels" error={fieldErrors.labels}>
            <Input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="comma, separated, tags"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>
        </FormGrid>
      </FormSection>

      {/* Section: Definition of Done */}
      <FormSection title="Definition of Done">
        {/* Description — progressive disclosure */}
        {showDescription ? (
          <Field label="Description" error={fieldErrors.description}>
            <TextareaInput
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details…"
              rows={3}
            />
          </Field>
        ) : (
          <button
            type="button"
            onClick={() => setShowDescription(true)}
            className="focus-ring inline-flex min-h-[44px] items-center rounded text-xs text-ink-muted transition-colors duration-200 hover:text-ink sm:min-h-0"
          >
            + Add description
          </button>
        )}

        {/* Acceptance criteria */}
        <Field label="Acceptance Criteria" error={fieldErrors.acceptance_criteria}>
          <TextareaInput
            value={acceptanceCriteria}
            onChange={(e) => setAcceptanceCriteria(e.target.value)}
            placeholder="Definition of done — what must be true for this task to be accepted?"
            rows={3}
          />
        </Field>

        {/* Checklist */}
        <div role="group" aria-labelledby={checklistLabelId}>
          <div className="mb-1.5 flex items-center justify-between">
            <FieldLabel id={checklistLabelId}>
              Checklist
              {checklist.length > 0 && (
                <span className="ml-2 text-xs font-normal text-ink-muted">
                  {checklist.filter((i) => i.done).length}/{checklist.length}
                </span>
              )}
            </FieldLabel>
          </div>
          {checklist.length > 0 && (
            <ul className="mb-2 space-y-1 rounded-md border border-border-subtle bg-well/40 px-3 py-1">
              {checklist.map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-sm">
                  <label className="flex min-h-[44px] flex-1 cursor-pointer items-center gap-2 sm:min-h-8">
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={() => toggleChecklistItem(item.id)}
                      className="focus-ring h-4 w-4 shrink-0 cursor-pointer accent-accent"
                    />
                    <span className={item.done ? "flex-1 text-ink-muted line-through" : "flex-1 text-ink"}>
                      {item.text}
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => removeChecklistItem(item.id)}
                    className="focus-ring grid min-h-[44px] min-w-[44px] shrink-0 place-items-center rounded text-xs text-ink-muted hover:text-danger-ink sm:min-h-8 sm:min-w-8"
                    aria-label={`Remove checklist item: ${item.text}`}
                  >
                    <span aria-hidden>×</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Input
              aria-label="Add checklist item"
              value={newItemText}
              onChange={(e) => setNewItemText(e.target.value)}
              placeholder="Add checklist item…"
              className="flex-1 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); addChecklistItem(); }
              }}
            />
            <button
              type="button"
              onClick={addChecklistItem}
              disabled={!newItemText.trim()}
              className="focus-ring h-11 rounded-md border border-border-subtle px-3 text-xs text-ink-secondary transition-colors hover:bg-well hover:text-ink disabled:opacity-40 sm:h-10"
            >
              Add
            </button>
          </div>
        </div>
      </FormSection>

      {/* Actions */}
      <FormActions>
        <Button type="button" variant="ghost" onClick={inspector.close} disabled={saving} className="w-full sm:w-auto h-11 sm:h-10">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving} className="w-full sm:w-auto h-11 sm:h-10">
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
      </FormActions>
    </form>
  );
}

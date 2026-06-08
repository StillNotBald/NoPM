"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { FieldLabel, FieldError, SelectInput, TextareaInput } from "@/components/forms/project-form";

// ── Data shape ────────────────────────────────────────────────────────────────

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  resolution: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  raised_at: string;
  due_date: string | null;
}

// ── IssueForm ─────────────────────────────────────────────────────────────────

export function IssueForm({
  projectId,
  issue,
}: {
  projectId: string;
  issue?: Issue;
}) {
  const modal = useModal();
  const router = useRouter();

  const [title, setTitle] = useState(issue?.title ?? "");
  const [description, setDescription] = useState(issue?.description ?? "");
  const [showDescription, setShowDescription] = useState(
    !!(issue?.description && issue.description.trim().length > 0)
  );
  const [priority, setPriority] = useState<Issue["priority"]>(
    issue?.priority ?? "medium"
  );
  const [resolution, setResolution] = useState(issue?.resolution ?? "");
  const [showResolution, setShowResolution] = useState(
    !!(issue?.resolution && issue.resolution.trim().length > 0)
  );
  const [status, setStatus] = useState<Issue["status"]>(
    issue?.status ?? "open"
  );
  const [dueDate, setDueDate] = useState(issue?.due_date?.slice(0, 10) ?? "");

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

    const payload = {
      title: title.trim(),
      description: description.trim(),
      priority,
      resolution: resolution.trim(),
      status,
      due_date: dueDate || null,
    };

    try {
      if (issue) {
        await apiPatch(`/api/issues/${issue.id}`, payload);
      } else {
        await apiPost(`/api/projects/${projectId}/issues`, payload);
      }
      router.refresh();
      modal.close();
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
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Issue title"
          required
          className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
        />
        <FieldError message={fieldErrors.title} />
      </div>

      {/* Compact properties grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-1">
        {/* Priority */}
        <div>
          <FieldLabel>Priority</FieldLabel>
          <SelectInput
            value={priority}
            onChange={(e) => setPriority(e.target.value as Issue["priority"])}
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
            value={status}
            onChange={(e) => setStatus(e.target.value as Issue["status"])}
          >
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </SelectInput>
          <FieldError message={fieldErrors.status} />
        </div>

        {/* Due date */}
        <div>
          <FieldLabel>Due Date</FieldLabel>
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="h-8 text-sm"
          />
          <FieldError message={fieldErrors.due_date} />
        </div>
      </div>

      {/* Description — progressive disclosure */}
      {showDescription ? (
        <div>
          <FieldLabel>Description</FieldLabel>
          <TextareaInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the issue…"
            rows={2}
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

      {/* Resolution — progressive disclosure */}
      {showResolution ? (
        <div>
          <FieldLabel>Resolution / Action</FieldLabel>
          <TextareaInput
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="Steps to resolve this issue…"
            rows={2}
          />
          <FieldError message={fieldErrors.resolution} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowResolution(true)}
          className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
        >
          + Add resolution
        </button>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-3">
        <Button type="button" variant="ghost" onClick={modal.close} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !title.trim()}>
          {saving ? (
            <>
              <Spinner size="sm" className="mr-2" />
              Saving…
            </>
          ) : issue ? (
            "Save Changes"
          ) : (
            "Add Issue"
          )}
        </Button>
      </div>
    </form>
  );
}

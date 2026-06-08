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

export interface Risk {
  id: string;
  project_id: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  likelihood: "low" | "medium" | "high" | "critical";
  category: string;
  mitigation: string;
  status: "open" | "mitigating" | "closed" | "accepted";
  raised_at: string;
  due_date: string | null;
}

// ── RiskForm ──────────────────────────────────────────────────────────────────

export function RiskForm({
  projectId,
  risk,
}: {
  projectId: string;
  risk?: Risk;
}) {
  const modal = useModal();
  const router = useRouter();

  const [title, setTitle] = useState(risk?.title ?? "");
  const [description, setDescription] = useState(risk?.description ?? "");
  const [showDescription, setShowDescription] = useState(
    !!(risk?.description && risk.description.trim().length > 0)
  );
  const [severity, setSeverity] = useState<Risk["severity"]>(
    risk?.severity ?? "medium"
  );
  const [likelihood, setLikelihood] = useState<Risk["likelihood"]>(
    risk?.likelihood ?? "medium"
  );
  const [category, setCategory] = useState(risk?.category ?? "");
  const [mitigation, setMitigation] = useState(risk?.mitigation ?? "");
  const [showMitigation, setShowMitigation] = useState(
    !!(risk?.mitigation && risk.mitigation.trim().length > 0)
  );
  const [status, setStatus] = useState<Risk["status"]>(
    risk?.status ?? "open"
  );
  const [dueDate, setDueDate] = useState(risk?.due_date?.slice(0, 10) ?? "");

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
      severity,
      likelihood,
      category: category.trim(),
      mitigation: mitigation.trim(),
      status,
      due_date: dueDate || null,
    };

    try {
      if (risk) {
        await apiPatch(`/api/risks/${risk.id}`, payload);
      } else {
        await apiPost(`/api/projects/${projectId}/risks`, payload);
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
          placeholder="Risk title"
          required
          className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
        />
        <FieldError message={fieldErrors.title} />
      </div>

      {/* Compact properties grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-1">
        {/* Severity */}
        <div>
          <FieldLabel>Severity</FieldLabel>
          <SelectInput
            value={severity}
            onChange={(e) => setSeverity(e.target.value as Risk["severity"])}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </SelectInput>
          <FieldError message={fieldErrors.severity} />
        </div>

        {/* Likelihood */}
        <div>
          <FieldLabel>Likelihood</FieldLabel>
          <SelectInput
            value={likelihood}
            onChange={(e) => setLikelihood(e.target.value as Risk["likelihood"])}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </SelectInput>
          <FieldError message={fieldErrors.likelihood} />
        </div>

        {/* Status */}
        <div>
          <FieldLabel>Status</FieldLabel>
          <SelectInput
            value={status}
            onChange={(e) => setStatus(e.target.value as Risk["status"])}
          >
            <option value="open">Open</option>
            <option value="mitigating">Mitigating</option>
            <option value="accepted">Accepted</option>
            <option value="closed">Closed</option>
          </SelectInput>
          <FieldError message={fieldErrors.status} />
        </div>

        {/* Category */}
        <div>
          <FieldLabel>Category</FieldLabel>
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Technical, Resource…"
            className="h-8 text-sm"
          />
          <FieldError message={fieldErrors.category} />
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
            placeholder="Describe the risk…"
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

      {/* Mitigation — progressive disclosure */}
      {showMitigation ? (
        <div>
          <FieldLabel>Mitigation Plan</FieldLabel>
          <TextareaInput
            value={mitigation}
            onChange={(e) => setMitigation(e.target.value)}
            placeholder="Steps to mitigate this risk…"
            rows={2}
          />
          <FieldError message={fieldErrors.mitigation} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowMitigation(true)}
          className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
        >
          + Add mitigation plan
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
          ) : risk ? (
            "Save Changes"
          ) : (
            "Add Risk"
          )}
        </Button>
      </div>
    </form>
  );
}

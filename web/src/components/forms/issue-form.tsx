"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { Field, FormError, TitleField, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";
import { validateFields } from "@/lib/forms/validate";

// ── Data shape ────────────────────────────────────────────────────────────────

export type IssueSeverity = "low" | "medium" | "high" | "critical";
export type IssueCategory =
  | "technical_defect"
  | "resource_unavailability"
  | "dependency_delay"
  | "budget_funding"
  | "scope_creep"
  | "stakeholder_conflict"
  | "operational_bottleneck"
  | "data_quality"
  | "third_party_vendor"
  | "environmental_external";

const ISSUE_CATEGORY_OPTIONS: { value: IssueCategory; label: string }[] = [
  { value: "technical_defect", label: "Technical / System Defect" },
  { value: "resource_unavailability", label: "Resource Unavailability" },
  { value: "dependency_delay", label: "Dependency Delay" },
  { value: "budget_funding", label: "Budget / Funding" },
  { value: "scope_creep", label: "Scope Creep" },
  { value: "stakeholder_conflict", label: "Stakeholder Conflict" },
  { value: "operational_bottleneck", label: "Operational Bottleneck" },
  { value: "data_quality", label: "Data Quality / Integrity" },
  { value: "third_party_vendor", label: "Third-Party / Vendor" },
  { value: "environmental_external", label: "Environmental / External" },
];

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
  // Content-enrichment P0 fields (migration 0008_content_enrichment) — optional
  // so narrower callers (e.g. list rows) still satisfy the prop type.
  severity?: IssueSeverity | null;
  issue_category?: IssueCategory | null;
  impact?: string | null;
  resolution_eta?: string | null;
  resolved_at?: string | null;
  // Optimistic concurrency (R-90) — present on any record loaded from the
  // API; carried back on PATCH as expected_updated_at when editing.
  updated_at?: string | null;
}

// ── IssueForm ─────────────────────────────────────────────────────────────────

/**
 * `projectId` is the project a NEW issue is filed under (and the project an
 * existing one belongs to). Pass `projects` from a cross-project register
 * (/issues) to show a required Project picker; project pages omit it because
 * their project is fixed. Editing never moves an issue between projects, so the
 * picker is create-only.
 */
export function IssueForm({
  projectId,
  projects,
  issue,
}: {
  projectId: string;
  projects?: Array<{ id: string; name: string }>;
  issue?: Issue;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const showProjectPicker = !issue && !!projects;
  const [selectedProjectId, setSelectedProjectId] = useState(() => {
    if (!projects) return projectId;
    if (projects.some((p) => p.id === projectId)) return projectId;
    return projects.length === 1 ? projects[0].id : "";
  });

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

  // Content-enrichment P0 fields.
  const [severity, setSeverity] = useState<IssueSeverity>(
    issue?.severity ?? "medium"
  );
  const [issueCategory, setIssueCategory] = useState<IssueCategory | "">(
    issue?.issue_category ?? ""
  );
  const [impact, setImpact] = useState(issue?.impact ?? "");
  const [showImpact, setShowImpact] = useState(
    !!(issue?.impact && issue.impact.trim().length > 0)
  );
  const [resolutionEta, setResolutionEta] = useState(
    issue?.resolution_eta?.slice(0, 10) ?? ""
  );
  const [resolvedAt, setResolvedAt] = useState(
    issue?.resolved_at?.slice(0, 10) ?? ""
  );

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
      { key: "title", value: title.trim(), message: "Issue title is required" },
      ...(showProjectPicker
        ? [{ key: "project_id", value: selectedProjectId, message: "Choose a project" }]
        : []),
    ]);
    if (!clientResult.ok) {
      setFieldErrors(clientResult.errors);
      return;
    }

    setSaving(true);

    const payload = {
      title: title.trim(),
      description: description.trim(),
      priority,
      resolution: resolution.trim(),
      status,
      due_date: dueDate || null,
      // Content-enrichment P0 fields (optional/nullable).
      severity,
      issue_category: issueCategory || null,
      impact: impact.trim() || null,
      resolution_eta: resolutionEta || null,
      resolved_at: resolvedAt || null,
      // Optimistic concurrency (R-90) — only meaningful (and only sent) on
      // an edit of an existing record; a create has nothing to be stale.
      ...(issue?.updated_at ? { expected_updated_at: issue.updated_at } : {}),
    };

    try {
      if (issue) {
        await apiPatch(`/api/issues/${issue.id}`, payload);
        toast.success("Issue updated");
      } else {
        await apiPost(`/api/projects/${selectedProjectId}/issues`, payload);
        toast.success("Issue created");
      }
      router.refresh();
      inspector.close();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 412) {
        setTopError("This record changed since you opened it. Reload to see the latest.");
        toast.error("This record changed since you opened it. Reload to see the latest.");
      } else {
        applyApiError(apiErr);
        toast.error(apiErr.message ?? "Failed to save issue");
      }
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <FormError message={topError} />

      {/* Title — prominent */}
      <TitleField
        label="Issue title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Issue title"
        required
        error={fieldErrors.title}
      />

      {showProjectPicker && (
        <Field label="Project" required error={fieldErrors.project_id}>
          <SelectInput
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            required
          >
            <option value="">— Select a project —</option>
            {projects!.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      )}

      {/* Section: Classification */}
      <FormSection title="Classification">
        <FormGrid>
          {/* Priority */}
          <Field label="Priority" error={fieldErrors.priority}>
            <SelectInput
              value={priority}
              onChange={(e) => setPriority(e.target.value as Issue["priority"])}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </SelectInput>
          </Field>

          {/* Severity */}
          <Field label="Severity" error={fieldErrors.severity}>
            <SelectInput
              value={severity}
              onChange={(e) => setSeverity(e.target.value as IssueSeverity)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </SelectInput>
          </Field>

          {/* Category */}
          <Field label="Category" error={fieldErrors.issue_category}>
            <SelectInput
              value={issueCategory}
              onChange={(e) =>
                setIssueCategory(e.target.value as IssueCategory | "")
              }
            >
              <option value="">Uncategorized</option>
              {ISSUE_CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </SelectInput>
          </Field>
        </FormGrid>
      </FormSection>

      {/* Section: Status & Dates */}
      <FormSection title="Status & Dates">
        <FormGrid>
          {/* Status */}
          <Field label="Status" error={fieldErrors.status}>
            <SelectInput
              value={status}
              onChange={(e) => setStatus(e.target.value as Issue["status"])}
            >
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </SelectInput>
          </Field>

          {/* Due date */}
          <Field label="Due Date" error={fieldErrors.due_date}>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Resolution ETA */}
          <Field label="Resolution ETA" error={fieldErrors.resolution_eta}>
            <Input
              type="date"
              value={resolutionEta}
              onChange={(e) => setResolutionEta(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Resolved date */}
          <Field label="Resolved On" error={fieldErrors.resolved_at}>
            <Input
              type="date"
              value={resolvedAt}
              onChange={(e) => setResolvedAt(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>
        </FormGrid>
      </FormSection>

      {/* Section: Details */}
      <FormSection title="Details">
        {/* Description — progressive disclosure */}
        {showDescription ? (
          <Field label="Description" error={fieldErrors.description}>
            <TextareaInput
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue…"
              rows={2}
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

        {/* Resolution — progressive disclosure */}
        {showResolution ? (
          <Field label="Resolution / Action" error={fieldErrors.resolution}>
            <TextareaInput
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="Steps to resolve this issue…"
              rows={2}
            />
          </Field>
        ) : (
          <button
            type="button"
            onClick={() => setShowResolution(true)}
            className="focus-ring inline-flex min-h-[44px] items-center rounded text-xs text-ink-muted transition-colors duration-200 hover:text-ink sm:min-h-0"
          >
            + Add resolution
          </button>
        )}

        {/* Impact — progressive disclosure */}
        {showImpact ? (
          <Field label="Impact" error={fieldErrors.impact}>
            <TextareaInput
              value={impact}
              onChange={(e) => setImpact(e.target.value)}
              placeholder="Impact of this issue on schedule, cost, scope…"
              rows={2}
            />
          </Field>
        ) : (
          <button
            type="button"
            onClick={() => setShowImpact(true)}
            className="focus-ring inline-flex min-h-[44px] items-center rounded text-xs text-ink-muted transition-colors duration-200 hover:text-ink sm:min-h-0"
          >
            + Add impact
          </button>
        )}
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
          ) : issue ? (
            "Save Changes"
          ) : (
            "Add Issue"
          )}
        </Button>
      </FormActions>
    </form>
  );
}

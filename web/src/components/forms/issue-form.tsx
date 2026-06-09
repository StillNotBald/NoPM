"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { FieldLabel, FieldError, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";
import { z } from "zod";

// ── Client-side validation schema ────────────────────────────────────────────
const issueClientSchema = z.object({
  title: z.string().min(1, "Issue title is required"),
});

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
}

// ── IssueForm ─────────────────────────────────────────────────────────────────

export function IssueForm({
  projectId,
  issue,
}: {
  projectId: string;
  issue?: Issue;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

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
    const clientResult = issueClientSchema.safeParse({ title });
    if (!clientResult.success) {
      const map: Record<string, string> = {};
      for (const issue of clientResult.error.issues) {
        const field = issue.path[0] as string;
        if (!map[field]) map[field] = issue.message;
      }
      setFieldErrors(map);
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
    };

    try {
      if (issue) {
        await apiPatch(`/api/issues/${issue.id}`, payload);
        toast.success("Issue updated");
      } else {
        await apiPost(`/api/projects/${projectId}/issues`, payload);
        toast.success("Issue created");
      }
      router.refresh();
      inspector.close();
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to save issue");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
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

      {/* Section: Classification */}
      <FormSection title="Classification">
        <FormGrid>
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

          {/* Severity */}
          <div>
            <FieldLabel>Severity</FieldLabel>
            <SelectInput
              value={severity}
              onChange={(e) => setSeverity(e.target.value as IssueSeverity)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </SelectInput>
            <FieldError message={fieldErrors.severity} />
          </div>

          {/* Category */}
          <div>
            <FieldLabel>Category</FieldLabel>
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
            <FieldError message={fieldErrors.issue_category} />
          </div>
        </FormGrid>
      </FormSection>

      {/* Section: Status & Dates */}
      <FormSection title="Status & Dates">
        <FormGrid>
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
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.due_date} />
          </div>

          {/* Resolution ETA */}
          <div>
            <FieldLabel>Resolution ETA</FieldLabel>
            <Input
              type="date"
              value={resolutionEta}
              onChange={(e) => setResolutionEta(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.resolution_eta} />
          </div>

          {/* Resolved date */}
          <div>
            <FieldLabel>Resolved On</FieldLabel>
            <Input
              type="date"
              value={resolvedAt}
              onChange={(e) => setResolvedAt(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.resolved_at} />
          </div>
        </FormGrid>
      </FormSection>

      {/* Section: Details */}
      <FormSection title="Details">
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

        {/* Impact — progressive disclosure */}
        {showImpact ? (
          <div>
            <FieldLabel>Impact</FieldLabel>
            <TextareaInput
              value={impact}
              onChange={(e) => setImpact(e.target.value)}
              placeholder="Impact of this issue on schedule, cost, scope…"
              rows={2}
            />
            <FieldError message={fieldErrors.impact} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowImpact(true)}
            className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
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
        <Button type="submit" variant="primary" disabled={saving || !title.trim()} className="w-full sm:w-auto h-11 sm:h-10">
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

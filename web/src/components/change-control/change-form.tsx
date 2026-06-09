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
import { createChangeRequestSchema } from "@/app/api/change-requests/_schema";

// ── Local types ───────────────────────────────────────────────────────────────

export type CRCategory = "scope" | "schedule" | "cost" | "quality" | "resource" | "other";
export type CRPriority = "low" | "medium" | "high" | "critical";
export type CRStatus =
  | "raised"
  | "under_review"
  | "approved"
  | "rejected"
  | "deferred"
  | "implemented";

export interface ChangeRequest {
  id: string;
  workspace_id: string;
  project_id: string | null;
  reference_id: string | null;
  title: string;
  description: string | null;
  category: CRCategory;
  priority: CRPriority;
  status: CRStatus;
  impact_summary: string | null;
  impact_schedule_days: number | null;
  impact_cost: number | null;
  requested_by: string | null;
  requested_by_label: string | null;
  decided_by: string | null;
  decided_by_label: string | null;
  decision_rationale: string | null;
  raised_at: string;
  decided_at: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
}

type Project = { id: string; name: string };

// ── ChangeForm ────────────────────────────────────────────────────────────────

export function ChangeForm({
  projects,
  changeRequest,
}: {
  projects: Project[];
  changeRequest?: ChangeRequest;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const [projectId, setProjectId] = useState(changeRequest?.project_id ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState(changeRequest?.title ?? "");
  const [description, setDescription] = useState(changeRequest?.description ?? "");
  const [showDescription, setShowDescription] = useState(
    !!(changeRequest?.description && changeRequest.description.trim().length > 0),
  );
  const [category, setCategory] = useState<CRCategory>(changeRequest?.category ?? "scope");
  const [priority, setPriority] = useState<CRPriority>(changeRequest?.priority ?? "medium");
  const [status, setStatus] = useState<CRStatus>(changeRequest?.status ?? "raised");
  const [impactSummary, setImpactSummary] = useState(changeRequest?.impact_summary ?? "");
  const [showImpact, setShowImpact] = useState(
    !!(changeRequest?.impact_summary && changeRequest.impact_summary.trim().length > 0),
  );
  const [impactScheduleDays, setImpactScheduleDays] = useState(
    changeRequest?.impact_schedule_days != null
      ? String(changeRequest.impact_schedule_days)
      : "",
  );
  const [impactCost, setImpactCost] = useState(
    changeRequest?.impact_cost != null ? String(changeRequest.impact_cost) : "",
  );
  const [targetDate, setTargetDate] = useState(
    changeRequest?.target_date?.slice(0, 10) ?? "",
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

    // Client-side validation — reuse the server schema's safeParse for
    // immediate inline errors before the network round-trip.
    const clientResult = createChangeRequestSchema.safeParse({
      title: title.trim(),
      description: description.trim() || null,
      category,
      priority,
      status,
      impact_summary: impactSummary.trim() || null,
      impact_schedule_days: impactScheduleDays !== "" ? Number(impactScheduleDays) : null,
      impact_cost: impactCost !== "" ? Number(impactCost) : null,
      target_date: targetDate || null,
    });
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
      description: description.trim() || null,
      category,
      priority,
      status,
      impact_summary: impactSummary.trim() || null,
      impact_schedule_days: impactScheduleDays !== "" ? Number(impactScheduleDays) : null,
      impact_cost: impactCost !== "" ? Number(impactCost) : null,
      target_date: targetDate || null,
    };

    try {
      if (changeRequest) {
        await apiPatch(`/api/change-requests/${changeRequest.id}`, payload);
        toast.success("Change request updated");
      } else {
        await apiPost(`/api/projects/${projectId}/change-requests`, payload);
        toast.success("Change request raised");
      }
      router.refresh();
      inspector.close();
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to save change request");
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
          placeholder="Change request title"
          required
          className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
        />
        <FieldError message={fieldErrors.title} />
      </div>

      {/* Compact properties grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1">
        {/* Project — only shown when creating */}
        {!changeRequest && (
          <div className="sm:col-span-2">
            <FieldLabel>Project</FieldLabel>
            <SelectInput
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectInput>
            <FieldError message={fieldErrors.project_id} />
          </div>
        )}

        {/* Category */}
        <div>
          <FieldLabel>Category</FieldLabel>
          <SelectInput
            value={category}
            onChange={(e) => setCategory(e.target.value as CRCategory)}
          >
            <option value="scope">Scope</option>
            <option value="schedule">Schedule</option>
            <option value="cost">Cost</option>
            <option value="quality">Quality</option>
            <option value="resource">Resource</option>
            <option value="other">Other</option>
          </SelectInput>
          <FieldError message={fieldErrors.category} />
        </div>

        {/* Priority */}
        <div>
          <FieldLabel>Priority</FieldLabel>
          <SelectInput
            value={priority}
            onChange={(e) => setPriority(e.target.value as CRPriority)}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </SelectInput>
          <FieldError message={fieldErrors.priority} />
        </div>

        {/* Status */}
        <div>
          <FieldLabel>Status</FieldLabel>
          <SelectInput
            value={status}
            onChange={(e) => setStatus(e.target.value as CRStatus)}
          >
            <option value="raised">Raised</option>
            <option value="under_review">Under Review</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="deferred">Deferred</option>
            <option value="implemented">Implemented</option>
          </SelectInput>
          <FieldError message={fieldErrors.status} />
        </div>

        {/* Target Date */}
        <div>
          <FieldLabel>Target Date</FieldLabel>
          <Input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.target_date} />
        </div>

        {/* Impact — schedule days */}
        <div>
          <FieldLabel>Schedule Impact (days)</FieldLabel>
          <Input
            type="number"
            value={impactScheduleDays}
            onChange={(e) => setImpactScheduleDays(e.target.value)}
            placeholder="e.g. +14 or -3"
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.impact_schedule_days} />
        </div>

        {/* Impact — cost */}
        <div>
          <FieldLabel>Cost Impact</FieldLabel>
          <Input
            type="number"
            step="0.01"
            value={impactCost}
            onChange={(e) => setImpactCost(e.target.value)}
            placeholder="e.g. 5000 or -1200"
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.impact_cost} />
        </div>
      </div>

      {/* Impact Summary — progressive disclosure */}
      {showImpact ? (
        <div>
          <FieldLabel>Impact Summary</FieldLabel>
          <TextareaInput
            value={impactSummary}
            onChange={(e) => setImpactSummary(e.target.value)}
            placeholder="Describe the impact of this change on scope, schedule, cost, quality…"
            rows={2}
          />
          <FieldError message={fieldErrors.impact_summary} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowImpact(true)}
          className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
        >
          + Add impact summary
        </button>
      )}

      {/* Description — progressive disclosure */}
      {showDescription ? (
        <div>
          <FieldLabel>Description</FieldLabel>
          <TextareaInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the change being requested…"
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

      {/* Actions */}
      <div className="flex flex-col-reverse gap-2 border-t border-border-subtle pt-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={inspector.close}
          disabled={saving}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={saving || !title.trim()}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          {saving ? (
            <>
              <Spinner size="sm" className="mr-2" />
              Saving…
            </>
          ) : changeRequest ? (
            "Save Changes"
          ) : (
            "Raise Change Request"
          )}
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import type { DecideState } from "@/components/governance/four-eyes-note";
import { FieldLabel, FieldError, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { FormShell, FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";
import {
  RAISE_TIME_STATUSES,
  createChangeRequestSchema,
  updateChangeRequestSchema,
} from "@/app/api/change-requests/_schema";

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
  /**
   * Whether the signed-in viewer may decide this request, worked out on the
   * server (lib/review/four-eyes). Derived, never stored; absent on rows that
   * did not come through the change-control page.
   */
  decide?: DecideState;
  /**
   * Server-computed: may this viewer edit it? Only the requester, and only
   * while it is open (decision 11). Absent means "not known": treated as no.
   */
  canEdit?: boolean;
}

type Project = { id: string; name: string };

// ── Create vs edit contract (pure, unit-tested) ───────────────────────────────
//
// The two modes talk to two different endpoints with two different schemas, so
// the form validates each against the schema its endpoint actually uses:
//
//   create  POST /api/projects/:id/change-requests  -> createChangeRequestSchema
//           `status` may only be a raise-time status (raised | under_review);
//           anything else is a 422 because a terminal status needs a decider.
//   edit    PATCH /api/change-requests/:id          -> updateChangeRequestSchema
//           has NO `status` field. A status only ever moves through the audited
//           four-eyes decision flow, so an edit never sends one — which is also
//           what lets an already approved / rejected request be edited at all.

export type ChangeFormMode = "create" | "edit";

/** The statuses a change request can be raised in, in the order the form offers them. */
export type RaiseStatus = (typeof RAISE_TIME_STATUSES)[number];
export const RAISE_STATUS_OPTIONS: readonly RaiseStatus[] = RAISE_TIME_STATUSES;

export const STATUS_LABEL: Record<CRStatus, string> = {
  raised: "Raised",
  under_review: "Under Review",
  approved: "Approved",
  rejected: "Rejected",
  deferred: "Deferred",
  implemented: "Implemented",
};

export interface ChangeFormValues {
  title: string;
  description: string;
  category: CRCategory;
  priority: CRPriority;
  /** Only meaningful on create; an edit never sends it. */
  status: CRStatus;
  impactSummary: string;
  impactScheduleDays: string;
  impactCost: string;
  targetDate: string;
}

/** The request body for the mode: `status` on create only. */
export function buildChangePayload(mode: ChangeFormMode, v: ChangeFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: v.title.trim(),
    description: v.description.trim() || null,
    category: v.category,
    priority: v.priority,
    impact_summary: v.impactSummary.trim() || null,
    impact_schedule_days: v.impactScheduleDays !== "" ? Number(v.impactScheduleDays) : null,
    impact_cost: v.impactCost !== "" ? Number(v.impactCost) : null,
    target_date: v.targetDate || null,
  };
  if (mode === "create") body.status = v.status;
  return body;
}

export type ChangeFormValidation =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

/**
 * Validates with the schema the mode's endpoint uses (first issue per field
 * wins), so the client never rejects what the server would accept, or the
 * reverse.
 */
export function validateChangeForm(mode: ChangeFormMode, v: ChangeFormValues): ChangeFormValidation {
  const payload = buildChangePayload(mode, v);
  const schema = mode === "create" ? createChangeRequestSchema : updateChangeRequestSchema;
  const result = schema.safeParse(payload);
  if (result.success) return { ok: true, payload };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "form");
    if (!errors[field]) errors[field] = issue.message;
  }
  return { ok: false, errors };
}

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
  // Raise-time status, create only. An edit shows the current status read-only.
  const [status, setStatus] = useState<RaiseStatus>("raised");
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

    // Client-side validation — the same schema the mode's endpoint uses, for
    // immediate inline errors before the network round-trip (see the create vs
    // edit contract above: an edit is validated against the update schema and
    // never carries `status`).
    const result = validateChangeForm(changeRequest ? "edit" : "create", {
      title,
      description,
      category,
      priority,
      status,
      impactSummary,
      impactScheduleDays,
      impactCost,
      targetDate,
    });
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    const payload = result.payload;

    setSaving(true);

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
    <FormShell
      main={
        <form onSubmit={handleSubmit} className="space-y-5">
          {topError && (
            <div className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger-ink">
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

          {/* Core properties */}
          <FormSection title="Properties">
            <FormGrid>
              {/* Project — only shown when creating */}
              {!changeRequest && (
                <div className="col-span-2">
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

              {/* Status — a request can only be RAISED as raised / under review; every
                  later status comes from a decision, so an edit shows it read-only. */}
              <div>
                <FieldLabel>Status</FieldLabel>
                {changeRequest ? (
                  <>
                    <p className="flex h-11 items-center text-sm text-ink sm:h-10">
                      {STATUS_LABEL[changeRequest.status]}
                    </p>
                    <p className="text-2xs text-ink-muted">
                      Status changes through an approval decision, not this form.
                    </p>
                  </>
                ) : (
                  <SelectInput
                    aria-label="Status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as RaiseStatus)}
                  >
                    {RAISE_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </SelectInput>
                )}
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
            </FormGrid>
          </FormSection>

          {/* Impact section */}
          <FormSection title="Impact">
            <FormGrid>
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
            </FormGrid>

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
          </FormSection>

          {/* Description — progressive disclosure */}
          <FormSection title="Details">
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
          </FormSection>

          <FormActions>
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
          </FormActions>
        </form>
      }
    />
  );
}

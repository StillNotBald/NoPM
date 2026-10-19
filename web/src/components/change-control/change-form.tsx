"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiGet, apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import type { DecideState } from "@/components/governance/four-eyes-note";
import { FieldLabel, FieldError, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { FormShell, FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";
import {
  IMPACT_AREAS,
  IMPACT_DIRECTIONS,
  RAISE_TIME_STATUSES,
  createChangeRequestSchema,
  updateChangeRequestSchema,
  type ImpactScopeItem,
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
  | "implemented"
  /** Legacy status of an emergency raised before migration 0106; it now commits on raise as "approved". */
  | "emergency";

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
  /** B2: structured impact by area (the free-text impact_summary stays). */
  impact_scope?: ImpactScopeItem[] | null;
  /** M2: stamped when an approved request is marked implemented. */
  implemented_at?: string | null;
  implemented_by_label?: string | null;
  implemented_note?: string | null;
  /** G1/R-159: approval tier, and the emergency path (committed on raise, no approver, flagged everywhere). */
  tier?: string | null;
  approval_deadline_at?: string | null;
  is_emergency?: boolean | null;
  /** Server-computed: still waiting and past approval_deadline_at. */
  deadline_overdue?: boolean;
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
  /** Server-computed: a manager or admin may move a raised request to under review (Q-GOV-3). */
  canStartReview?: boolean;
  /** Server-computed: may this viewer mark an approved request implemented? The requester, or a manager or admin. */
  canImplement?: boolean;
  /** B1: decisions taken for this request (server-computed from decisions.change_request_id). */
  decisions?: Array<{ id: string; reference_id: string | null; title: string }>;
  /** Server-computed: may this viewer reopen it? Deferred only; the requester or a manager or admin (decision 24). */
  canReopen?: boolean;
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
  emergency: "Emergency",
};

export const AREA_LABELS: Record<(typeof IMPACT_AREAS)[number], string> = {
  scope: "Scope",
  schedule: "Schedule",
  cost: "Cost",
  quality: "Quality",
  resources: "Resources",
  compliance: "Compliance",
};
export const DIRECTION_LABELS: Record<(typeof IMPACT_DIRECTIONS)[number], string> = {
  increase: "Increase",
  decrease: "Decrease",
  neutral: "No change",
};

/** Form state for one impact area: "" = not affected. */
export type ImpactScopeDraft = Record<(typeof IMPACT_AREAS)[number], { direction: "" | (typeof IMPACT_DIRECTIONS)[number]; note: string }>;

export function impactScopeToDraft(list: ImpactScopeItem[] | null | undefined): ImpactScopeDraft {
  const draft = Object.fromEntries(IMPACT_AREAS.map((a) => [a, { direction: "", note: "" }])) as ImpactScopeDraft;
  for (const item of list ?? []) draft[item.area] = { direction: item.direction, note: item.note ?? "" };
  return draft;
}

export function draftToImpactScope(draft: ImpactScopeDraft): ImpactScopeItem[] {
  return IMPACT_AREAS.flatMap((area) =>
    draft[area].direction
      ? [{ area, direction: draft[area].direction as ImpactScopeItem["direction"], note: draft[area].note.trim() || null }]
      : [],
  );
}

const DIRECTION_SHORT = { increase: "up", decrease: "down", neutral: "same" } as const;

/** One line for the list's Impact column: the summary, else the affected areas ("Scope up, Cost down"), else a dash. */
export function impactCellText(cr: Pick<ChangeRequest, "impact_summary" | "impact_scope">): string {
  if (cr.impact_summary && cr.impact_summary.trim() !== "") return cr.impact_summary;
  const list = cr.impact_scope ?? [];
  if (list.length === 0) return "—";
  return list.map((i) => AREA_LABELS[i.area] + " " + DIRECTION_SHORT[i.direction]).join(", ");
}

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
  /** B2: structured impact by area; omitted = leave as is (an edit that does not touch it). */
  impactScope?: ImpactScopeItem[];
  /** Create only. "" = let the server decide (normal, lifted to high risk by the workspace thresholds). */
  tier?: "" | "routine" | "normal" | "high_risk" | "strategic";
  /** Create only; a manager or admin ticks it to commit at once with no approval; it is flagged everywhere. */
  isEmergency?: boolean;
  /** Create only; the one approver the request waits for. "" = nobody in particular. */
  assignedApproverId?: string;
}

/** Tier choices the form offers (UAT-004). Routine needs no cost, schedule or scope impact; strategic is admin-only. */
export function tierOptions(input: {
  role: string | null;
  hasCost: boolean;
  hasDays: boolean;
  hasScope: boolean;
}): { value: NonNullable<ChangeFormValues["tier"]>; label: string; disabled?: boolean }[] {
  const routineBlocked = input.hasCost || input.hasDays || input.hasScope;
  return [
    { value: "", label: "Automatic (recommended)" },
    { value: "routine", label: routineBlocked ? "Routine (only with no cost, schedule or scope impact)" : "Routine", disabled: routineBlocked },
    { value: "normal", label: "Normal" },
    { value: "high_risk", label: "High risk" },
    ...(input.role === "admin" ? [{ value: "strategic" as const, label: "Strategic" }] : []),
  ];
}

/** R-159: true when a change request is on the emergency path (flag or tier). */
export const isEmergencyChange = (cr: { is_emergency?: boolean | null; tier?: string | null }) =>
  cr.is_emergency === true || cr.tier === "emergency";

/** Only a manager or admin may use the emergency path (the server refuses everyone else). */
export const canRaiseEmergency = (role: string | null | undefined) => role === "admin" || role === "manager";

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
  if (v.impactScope !== undefined) body.impact_scope = v.impactScope.length > 0 ? v.impactScope : null;
  if (mode === "create") {
    body.status = v.status;
    if (v.isEmergency) body.is_emergency = true;
    else if (v.tier) body.tier = v.tier;
    if (v.assignedApproverId) body.assigned_approver_id = v.assignedApproverId;
  }
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
  const [scopeDraft, setScopeDraft] = useState<ImpactScopeDraft>(() => impactScopeToDraft(changeRequest?.impact_scope));
  const setArea = (area: (typeof IMPACT_AREAS)[number], patch: Partial<ImpactScopeDraft[typeof area]>) =>
    setScopeDraft((d) => ({ ...d, [area]: { ...d[area], ...patch } }));

  // UAT-004: tier, emergency and approver, create only.
  const [tier, setTier] = useState<NonNullable<ChangeFormValues["tier"]>>("");
  const [isEmergency, setIsEmergency] = useState(false);
  const [assignedApproverId, setAssignedApproverId] = useState("");
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [approvers, setApprovers] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (changeRequest) return;
    let live = true;
    apiGet<{ id?: string; role?: string | null } | null>("/api/me")
      .then(async (me) => {
        if (!live) return;
        setViewerRole(me?.role ?? null);
        if (me?.role === "admin" || me?.role === "manager") {
          const members = await apiGet<{ id: string; display_name: string | null; email: string | null; role: string; status: string }[]>(
            "/api/members",
          ).catch(() => []);
          if (!live) return;
          setApprovers(
            members
              .filter((m) => m.status === "active" && (m.role === "admin" || m.role === "manager") && m.id !== me?.id)
              .map((m) => ({ id: m.id, label: `${m.display_name || m.email || "Unnamed"} (${m.role})` })),
          );
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [changeRequest]);

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
      impactScope: draftToImpactScope(scopeDraft),
      tier,
      isEmergency,
      assignedApproverId,
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

          {/* UAT-004: approval tier, approver and the emergency path. Create only: the tier is the server's to raise, never lower. */}
          {!changeRequest && (
            <FormSection title="Approval">
              <FormGrid>
              {!changeRequest && (
                <div>
                  <FieldLabel>Approval tier</FieldLabel>
                  <SelectInput
                    aria-label="Approval tier"
                    value={isEmergency ? "" : tier}
                    disabled={isEmergency}
                    onChange={(e) => setTier(e.target.value as NonNullable<ChangeFormValues["tier"]>)}
                  >
                    {tierOptions({
                      role: viewerRole,
                      hasCost: impactCost.trim() !== "" && Number(impactCost) !== 0,
                      hasDays: impactScheduleDays.trim() !== "" && Number(impactScheduleDays) !== 0,
                      hasScope: draftToImpactScope(scopeDraft).length > 0,
                    }).map((o) => (
                      <option key={o.value} value={o.value} disabled={o.disabled}>
                        {o.label}
                      </option>
                    ))}
                  </SelectInput>
                  <p className="text-2xs text-ink-muted">
                    Automatic picks normal, and high risk for a large cost or a long slip.
                  </p>
                  <FieldError message={fieldErrors.tier} />
                </div>
              )}

              {!changeRequest && approvers.length > 0 && (
                <div>
                  <FieldLabel>Approver (optional)</FieldLabel>
                  <SelectInput
                    aria-label="Approver"
                    value={assignedApproverId}
                    onChange={(e) => setAssignedApproverId(e.target.value)}
                  >
                    <option value="">Anyone who can approve it</option>
                    {approvers.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </SelectInput>
                  <FieldError message={fieldErrors.assigned_approver_id} />
                </div>
              )}

              </FormGrid>
          {!changeRequest && canRaiseEmergency(viewerRole) && (
            <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md py-1">
              <input
                type="checkbox"
                checked={isEmergency}
                onChange={(e) => setIsEmergency(e.target.checked)}
                className="focus-ring mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border-subtle accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-sm text-ink">Emergency: commit now, no approval</span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  The change commits immediately with no approver and is flagged as an emergency in every report.
                </span>
              </span>
            </label>
          )}

            </FormSection>
          )}

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

            {/* B2: structured impact by area. Not affected = no entry. */}
            <fieldset className="space-y-2">
              <legend className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-muted">
                Impact by area
              </legend>
              {IMPACT_AREAS.map((area) => (
                <div key={area} className="grid grid-cols-1 gap-2 sm:grid-cols-[7rem_10rem_1fr] sm:items-center">
                  <span className="text-sm text-ink">{AREA_LABELS[area]}</span>
                  <SelectInput
                    aria-label={`${AREA_LABELS[area]} impact`}
                    value={scopeDraft[area].direction}
                    onChange={(e) => setArea(area, { direction: e.target.value as ImpactScopeDraft[typeof area]["direction"] })}
                  >
                    <option value="">Not affected</option>
                    {IMPACT_DIRECTIONS.map((d) => (
                      <option key={d} value={d}>
                        {DIRECTION_LABELS[d]}
                      </option>
                    ))}
                  </SelectInput>
                  {scopeDraft[area].direction && (
                    <Input
                      aria-label={`${AREA_LABELS[area]} note`}
                      value={scopeDraft[area].note}
                      onChange={(e) => setArea(area, { note: e.target.value })}
                      placeholder="Note"
                      className="h-11 sm:h-10 text-base sm:text-sm"
                    />
                  )}
                </div>
              ))}
              <FieldError message={fieldErrors.impact_scope} />
            </fieldset>

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

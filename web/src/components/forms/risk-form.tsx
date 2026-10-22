"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { Field, FieldError, FieldLabel, FormError, TitleField, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";
import { BackupOwnerField, useBackupOwner } from "@/components/forms/backup-owner-field";
import { IMPACT_AREA_OPTIONS } from "@/lib/risk/impact-areas";
import { validateFields } from "@/lib/forms/validate";

// ── Data shape ────────────────────────────────────────────────────────────────

export type RiskResponseStrategy = "avoid" | "transfer" | "mitigate" | "accept";

export type RiskCategoryValue =
  | "technical"
  | "schedule"
  | "cost"
  | "resourcing"
  | "scope_requirements"
  | "supplier_external"
  | "regulatory_legal"
  | "organisational";

export type RiskImpactArea =
  | "schedule"
  | "cost"
  | "scope"
  | "quality"
  | "reputation"
  | "compliance";

export interface Risk {
  id: string;
  project_id: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  likelihood: "low" | "medium" | "high" | "critical";
  mitigation: string;
  status: "open" | "mitigating" | "closed" | "accepted";
  raised_at: string;
  due_date: string | null;
  // Content-enrichment (0008) — PMBOK risk-register fields.
  // Optional on the type so consumers holding a pre-enrichment Risk shape still
  // satisfy this prop; nullable because every backing column is nullable/defaulted.
  probability_pct?: number | null;
  impact_score?: number | null;
  response_strategy?: RiskResponseStrategy;
  risk_category?: RiskCategoryValue | null;
  /** @deprecated use impact_areas (kept for rows read before 0091). */
  impact_area?: RiskImpactArea | null;
  impact_areas?: RiskImpactArea[];
  /** M6: a login who picks this risk up if its owner is away. */
  backup_owner_id?: string | null;
  trigger?: string | null;
  residual_risk?: string | null;
  resolution?: string | null;
  // Optimistic concurrency (R-90) — present on any record loaded from the
  // API; carried back on PATCH as expected_updated_at when editing.
  updated_at?: string | null;
}

const RISK_CATEGORY_OPTIONS: { value: RiskCategoryValue; label: string }[] = [
  { value: "technical", label: "Technical" },
  { value: "schedule", label: "Schedule" },
  { value: "cost", label: "Cost / Funding" },
  { value: "resourcing", label: "Resourcing" },
  { value: "scope_requirements", label: "Scope / Requirements" },
  { value: "supplier_external", label: "Supplier / External" },
  { value: "regulatory_legal", label: "Regulatory / Legal" },
  { value: "organisational", label: "Organisational / Change" },
];


// ── RiskForm ──────────────────────────────────────────────────────────────────

/**
 * `projectId` is the project a NEW risk is filed under (and the project an
 * existing one belongs to). Pass `projects` from a cross-project register
 * (/risks) to show a required Project picker: without it the form can only
 * file under the id it was handed, and a register has no honest default.
 * Project pages omit `projects` — their project is fixed. Editing never moves
 * a risk between projects, so the picker is create-only.
 */
export function RiskForm({
  projectId,
  projects,
  risk,
}: {
  projectId: string;
  projects?: Array<{ id: string; name: string }>;
  risk?: Risk;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const showProjectPicker = !risk && !!projects;
  const [selectedProjectId, setSelectedProjectId] = useState(() => {
    if (!projects) return projectId;
    if (projects.some((p) => p.id === projectId)) return projectId;
    return projects.length === 1 ? projects[0].id : "";
  });

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
  const [mitigation, setMitigation] = useState(risk?.mitigation ?? "");
  const [showMitigation, setShowMitigation] = useState(
    !!(risk?.mitigation && risk.mitigation.trim().length > 0)
  );
  const [status, setStatus] = useState<Risk["status"]>(
    risk?.status ?? "open"
  );
  const [dueDate, setDueDate] = useState(risk?.due_date?.slice(0, 10) ?? "");

  // Content-enrichment (0008) — PMBOK risk-register fields
  const [responseStrategy, setResponseStrategy] = useState<RiskResponseStrategy>(
    risk?.response_strategy ?? "mitigate"
  );
  const [riskCategory, setRiskCategory] = useState<RiskCategoryValue | "">(
    risk?.risk_category ?? ""
  );
  const [impactAreas, setImpactAreas] = useState<RiskImpactArea[]>(
    risk?.impact_areas ?? (risk?.impact_area ? [risk.impact_area] : [])
  );
  function toggleImpactArea(area: RiskImpactArea) {
    setImpactAreas((cur) => (cur.includes(area) ? cur.filter((a) => a !== area) : [...cur, area]));
  }
  const [probabilityPct, setProbabilityPct] = useState(
    risk?.probability_pct != null ? String(risk.probability_pct) : ""
  );
  const [impactScore, setImpactScore] = useState(
    risk?.impact_score != null ? String(risk.impact_score) : ""
  );
  const [trigger, setTrigger] = useState(risk?.trigger ?? "");
  const [residualRisk, setResidualRisk] = useState(risk?.residual_risk ?? "");

  const [resolution, setResolution] = useState(risk?.resolution ?? "");

  const backup = useBackupOwner("risks", risk?.id, risk?.backup_owner_id);
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
      { key: "title", value: title.trim(), message: "Risk title is required" },
      ...(status === "closed"
        ? [{ key: "resolution", value: resolution.trim(), message: "Add a short note on how this was resolved." }]
        : []),
      ...(showProjectPicker
        ? [{ key: "project_id", value: selectedProjectId, message: "Choose a project" }]
        : []),
    ]);
    if (!clientResult.ok) {
      setFieldErrors(clientResult.errors);
      return;
    }

    setSaving(true);

    const probabilityValue =
      probabilityPct.trim() === "" ? null : Number(probabilityPct);
    const impactValue = impactScore.trim() === "" ? null : Number(impactScore);

    const payload = {
      title: title.trim(),
      description: description.trim(),
      severity,
      likelihood,
      mitigation: mitigation.trim(),
      status,
      due_date: dueDate || null,
      // Content-enrichment (0008) — optional PMBOK fields
      response_strategy: responseStrategy,
      risk_category: riskCategory || null,
      impact_areas: impactAreas,
      probability_pct: probabilityValue,
      impact_score: impactValue,
      trigger: trigger.trim() || null,
      residual_risk: residualRisk.trim() || null,
      resolution: resolution.trim() || null,
      ...backup.payload(Boolean(risk)),
      // Optimistic concurrency (R-90) — only meaningful (and only sent) on
      // an edit of an existing record; a create has nothing to be stale.
      ...(risk?.updated_at ? { expected_updated_at: risk.updated_at } : {}),
    };

    try {
      if (risk) {
        await apiPatch(`/api/risks/${risk.id}`, payload);
        toast.success("Risk updated");
      } else {
        await apiPost(`/api/projects/${selectedProjectId}/risks`, payload);
        toast.success("Risk created");
      }
      router.refresh();
      inspector.close();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 412) {
        setTopError("This record changed. Reload to see the latest.");
        toast.error("This record changed. Reload to see the latest.");
      } else {
        applyApiError(apiErr);
        toast.error(apiErr.message ?? "Failed to save risk");
      }
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <FormError message={topError} />

      {/* Title — prominent */}
      <TitleField
        label="Risk title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Risk title"
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
          {/* Severity */}
          <Field label="Severity" error={fieldErrors.severity}>
            <SelectInput
              value={severity}
              onChange={(e) => setSeverity(e.target.value as Risk["severity"])}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </SelectInput>
          </Field>

          {/* Likelihood */}
          <Field label="Likelihood" error={fieldErrors.likelihood}>
            <SelectInput
              value={likelihood}
              onChange={(e) => setLikelihood(e.target.value as Risk["likelihood"])}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </SelectInput>
          </Field>

          {/* Risk category */}
          <Field label="Risk Category" error={fieldErrors.risk_category}>
            <SelectInput
              value={riskCategory}
              onChange={(e) =>
                setRiskCategory(e.target.value as RiskCategoryValue | "")
              }
            >
              <option value="">— Select category —</option>
              {RISK_CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </SelectInput>
          </Field>

          {/* Backup owner (M6) */}
          <BackupOwnerField state={backup} error={fieldErrors.backup_owner_id} />
        </FormGrid>
      </FormSection>

      {/* Section: Assessment */}
      <FormSection title="Assessment">
        <FormGrid>
          {/* Probability (%) */}
          <Field label="Probability (%)" error={fieldErrors.probability_pct}>
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              value={probabilityPct}
              onChange={(e) => setProbabilityPct(e.target.value)}
              placeholder="0–100"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Impact score (1–5) */}
          <Field label="Impact Score (1–5)" error={fieldErrors.impact_score}>
            <Input
              type="number"
              min={1}
              max={5}
              step={1}
              value={impactScore}
              onChange={(e) => setImpactScore(e.target.value)}
              placeholder="1–5"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Impact areas (K2): a risk can touch more than one */}
          <fieldset className="min-w-0 sm:col-span-2" aria-describedby={fieldErrors.impact_areas ? "impact-areas-error" : undefined}>
            <legend className="p-0">
              <FieldLabel>Impact Areas</FieldLabel>
            </legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {IMPACT_AREA_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-ink sm:min-h-8"
                >
                  <input
                    type="checkbox"
                    checked={impactAreas.includes(opt.value)}
                    onChange={() => toggleImpactArea(opt.value)}
                    className="focus-ring h-4 w-4 shrink-0 cursor-pointer accent-accent"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
            <FieldError id="impact-areas-error" message={fieldErrors.impact_areas} />
          </fieldset>
        </FormGrid>
      </FormSection>

      {/* Section: Response */}
      <FormSection title="Response">
        <FormGrid>
          {/* Response strategy */}
          <Field label="Response Strategy" error={fieldErrors.response_strategy}>
            <SelectInput
              value={responseStrategy}
              onChange={(e) =>
                setResponseStrategy(e.target.value as RiskResponseStrategy)
              }
            >
              <option value="avoid">Avoid</option>
              <option value="transfer">Transfer</option>
              <option value="mitigate">Mitigate</option>
              <option value="accept">Accept</option>
            </SelectInput>
          </Field>

          {/* Status */}
          <Field label="Status" error={fieldErrors.status}>
            <SelectInput
              value={status}
              onChange={(e) => setStatus(e.target.value as Risk["status"])}
            >
              <option value="open">Open</option>
              <option value="mitigating">Mitigating</option>
              <option value="accepted">Accepted</option>
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
        </FormGrid>

        {/* Resolution — required when closing (Q-WRK-19) */}
        {(status === "closed" || resolution.trim().length > 0) && (
          <Field label="Resolution" required={status === "closed"} error={fieldErrors.resolution}>
            <TextareaInput
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="How was this risk resolved?"
              rows={2}
            />
          </Field>
        )}

        {/* Mitigation — progressive disclosure */}
        {showMitigation ? (
          <Field label="Mitigation Plan" error={fieldErrors.mitigation}>
            <TextareaInput
              value={mitigation}
              onChange={(e) => setMitigation(e.target.value)}
              placeholder="Steps to mitigate this risk…"
              rows={2}
            />
          </Field>
        ) : (
          <button
            type="button"
            onClick={() => setShowMitigation(true)}
            className="focus-ring inline-flex min-h-[44px] items-center rounded text-xs text-ink-muted transition-colors duration-200 hover:text-ink sm:min-h-0"
          >
            + Add mitigation plan
          </button>
        )}
      </FormSection>

      {/* Section: Details */}
      <FormSection title="Details">
        {/* Description — progressive disclosure */}
        {showDescription ? (
          <Field label="Description" error={fieldErrors.description}>
            <TextareaInput
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the risk…"
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

        {/* Trigger — early-warning indicator */}
        <Field label="Trigger / Early Warning" error={fieldErrors.trigger}>
          <TextareaInput
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            placeholder="Signs this risk is happening…"
            rows={2}
          />
        </Field>

        {/* Residual risk — remaining after the chosen response */}
        <Field label="Residual Risk" error={fieldErrors.residual_risk}>
          <TextareaInput
            value={residualRisk}
            onChange={(e) => setResidualRisk(e.target.value)}
            placeholder="Risk left after the response…"
            rows={2}
          />
        </Field>
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
          ) : risk ? (
            "Save Changes"
          ) : (
            "Add Risk"
          )}
        </Button>
      </FormActions>
    </form>
  );
}

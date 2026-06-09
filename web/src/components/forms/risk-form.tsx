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
import { z } from "zod";

// ── Client-side validation schema ────────────────────────────────────────────
const riskClientSchema = z.object({
  title: z.string().min(1, "Risk title is required"),
});

// ── Data shape ────────────────────────────────────────────────────────────────

export type RiskResponseStrategy = "avoid" | "transfer" | "mitigate" | "accept";

export type RiskCategoryValue =
  | "timeline_schedule"
  | "dependencies_third_party"
  | "operational_continuity"
  | "technology_infrastructure"
  | "financial_capex"
  | "resource_management"
  | "scope_management"
  | "data_information"
  | "compliance_regulatory"
  | "change_stakeholder";

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
  category: string;
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
  impact_area?: RiskImpactArea | null;
  trigger?: string | null;
  residual_risk?: string | null;
}

const RISK_CATEGORY_OPTIONS: { value: RiskCategoryValue; label: string }[] = [
  { value: "timeline_schedule", label: "Timeline / Schedule" },
  { value: "dependencies_third_party", label: "Dependencies / Third-party" },
  { value: "operational_continuity", label: "Operational Continuity" },
  { value: "technology_infrastructure", label: "Technology / Infrastructure" },
  { value: "financial_capex", label: "Financial / CapEx" },
  { value: "resource_management", label: "Resource Management" },
  { value: "scope_management", label: "Scope Management" },
  { value: "data_information", label: "Data / Information" },
  { value: "compliance_regulatory", label: "Compliance / Regulatory" },
  { value: "change_stakeholder", label: "Change / Stakeholder" },
];

const IMPACT_AREA_OPTIONS: { value: RiskImpactArea; label: string }[] = [
  { value: "schedule", label: "Schedule" },
  { value: "cost", label: "Cost" },
  { value: "scope", label: "Scope" },
  { value: "quality", label: "Quality" },
  { value: "reputation", label: "Reputation" },
  { value: "compliance", label: "Compliance" },
];

// ── RiskForm ──────────────────────────────────────────────────────────────────

export function RiskForm({
  projectId,
  risk,
}: {
  projectId: string;
  risk?: Risk;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

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

  // Content-enrichment (0008) — PMBOK risk-register fields
  const [responseStrategy, setResponseStrategy] = useState<RiskResponseStrategy>(
    risk?.response_strategy ?? "mitigate"
  );
  const [riskCategory, setRiskCategory] = useState<RiskCategoryValue | "">(
    risk?.risk_category ?? ""
  );
  const [impactArea, setImpactArea] = useState<RiskImpactArea | "">(
    risk?.impact_area ?? ""
  );
  const [probabilityPct, setProbabilityPct] = useState(
    risk?.probability_pct != null ? String(risk.probability_pct) : ""
  );
  const [impactScore, setImpactScore] = useState(
    risk?.impact_score != null ? String(risk.impact_score) : ""
  );
  const [trigger, setTrigger] = useState(risk?.trigger ?? "");
  const [residualRisk, setResidualRisk] = useState(risk?.residual_risk ?? "");

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
    const clientResult = riskClientSchema.safeParse({ title });
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

    const probabilityValue =
      probabilityPct.trim() === "" ? null : Number(probabilityPct);
    const impactValue = impactScore.trim() === "" ? null : Number(impactScore);

    const payload = {
      title: title.trim(),
      description: description.trim(),
      severity,
      likelihood,
      category: category.trim(),
      mitigation: mitigation.trim(),
      status,
      due_date: dueDate || null,
      // Content-enrichment (0008) — optional PMBOK fields
      response_strategy: responseStrategy,
      risk_category: riskCategory || null,
      impact_area: impactArea || null,
      probability_pct: probabilityValue,
      impact_score: impactValue,
      trigger: trigger.trim() || null,
      residual_risk: residualRisk.trim() || null,
    };

    try {
      if (risk) {
        await apiPatch(`/api/risks/${risk.id}`, payload);
        toast.success("Risk updated");
      } else {
        await apiPost(`/api/projects/${projectId}/risks`, payload);
        toast.success("Risk created");
      }
      router.refresh();
      inspector.close();
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to save risk");
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1">
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
            className="h-11 sm:h-10 text-base sm:text-sm"
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
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <FieldError message={fieldErrors.due_date} />
        </div>

        {/* Response strategy */}
        <div>
          <FieldLabel>Response Strategy</FieldLabel>
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
          <FieldError message={fieldErrors.response_strategy} />
        </div>

        {/* Risk category */}
        <div>
          <FieldLabel>Risk Category</FieldLabel>
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
          <FieldError message={fieldErrors.risk_category} />
        </div>

        {/* Impact area */}
        <div>
          <FieldLabel>Impact Area</FieldLabel>
          <SelectInput
            value={impactArea}
            onChange={(e) =>
              setImpactArea(e.target.value as RiskImpactArea | "")
            }
          >
            <option value="">— Select area —</option>
            {IMPACT_AREA_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </SelectInput>
          <FieldError message={fieldErrors.impact_area} />
        </div>

        {/* Probability (%) */}
        <div>
          <FieldLabel>Probability (%)</FieldLabel>
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
          <FieldError message={fieldErrors.probability_pct} />
        </div>

        {/* Impact score (1–5) */}
        <div>
          <FieldLabel>Impact Score (1–5)</FieldLabel>
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
          <FieldError message={fieldErrors.impact_score} />
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

      {/* Trigger — early-warning indicator */}
      <div>
        <FieldLabel>Trigger / Early Warning</FieldLabel>
        <TextareaInput
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          placeholder="What signals that this risk is materializing…"
          rows={2}
        />
        <FieldError message={fieldErrors.trigger} />
      </div>

      {/* Residual risk — remaining after the chosen response */}
      <div>
        <FieldLabel>Residual Risk</FieldLabel>
        <TextareaInput
          value={residualRisk}
          onChange={(e) => setResidualRisk(e.target.value)}
          placeholder="Risk remaining after the response is applied…"
          rows={2}
        />
        <FieldError message={fieldErrors.residual_risk} />
      </div>

      {/* Actions */}
      <div className="flex flex-col-reverse gap-2 border-t border-border-subtle pt-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={inspector.close} disabled={saving} className="w-full sm:w-auto h-11 sm:h-10">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !title.trim()} className="w-full sm:w-auto h-11 sm:h-10">
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

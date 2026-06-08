"use client";

import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Button } from "@/components/ui/button";
import { RiskForm, type Risk, type RiskResponseStrategy } from "@/components/forms/risk-form";
import {
  riskScore,
  exposureBand,
  type ExposureBand,
} from "@/components/registers/risk-heatmap";

// ── Local type helpers ────────────────────────────────────────────────────────

type SeverityLevel = "low" | "medium" | "high" | "critical";
type RiskStatus = "open" | "mitigating" | "closed" | "accepted";

function statusTone(s: RiskStatus) {
  if (s === "closed" || s === "accepted") return "success" as const;
  if (s === "mitigating") return "warning" as const;
  if (s === "open") return "info" as const;
  return "neutral" as const;
}

const BAND_TO_SEVERITY: Record<ExposureBand, SeverityLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
};

const STRATEGY_LABEL: Record<RiskResponseStrategy, string> = {
  avoid: "Avoid",
  transfer: "Transfer",
  mitigate: "Mitigate",
  accept: "Accept",
};

function strategyTone(s: RiskResponseStrategy) {
  if (s === "avoid") return "danger" as const;
  if (s === "transfer") return "info" as const;
  if (s === "mitigate") return "warning" as const;
  return "success" as const;
}

const RISK_CATEGORY_LABELS: Record<string, string> = {
  timeline_schedule: "Timeline / Schedule",
  dependencies_third_party: "Dependencies / Third-party",
  operational_continuity: "Operational Continuity",
  technology_infrastructure: "Technology / Infrastructure",
  financial_capex: "Financial / CapEx",
  resource_management: "Resource Management",
  scope_management: "Scope Management",
  data_information: "Data / Information",
  compliance_regulatory: "Compliance / Regulatory",
  change_stakeholder: "Change / Stakeholder",
};

const IMPACT_AREA_LABELS: Record<string, string> = {
  schedule: "Schedule",
  cost: "Cost",
  scope: "Scope",
  quality: "Quality",
  reputation: "Reputation",
  compliance: "Compliance",
};

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ── RiskDetailRow — a labelled field row ──────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 border-b border-border-subtle last:border-0">
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

function TextValue({ value }: { value: string | null | undefined }) {
  if (!value || value.trim() === "") {
    return <span className="text-ink-muted">—</span>;
  }
  return <span className="whitespace-pre-wrap">{value}</span>;
}

// ── RiskDetail ─────────────────────────────────────────────────────────────────

export interface RiskDetailProps {
  risk: Risk & {
    reference_id?: string | null;
    project_id: string;
  };
  projectName?: string;
  ownerName?: string;
}

export function RiskDetail({ risk, projectName, ownerName }: RiskDetailProps) {
  const inspector = useInspector();

  const score = riskScore(risk.probability_pct ?? null, risk.impact_score ?? null);
  const band = exposureBand(score);

  function openEdit() {
    inspector.open(<RiskForm projectId={risk.project_id} risk={risk} />, "Edit Risk");
  }

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 pb-3 border-b border-border-subtle mb-1">
        <div className="flex-1 min-w-0">
          {risk.reference_id && (
            <span className="font-mono text-[11px] bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted mb-1 inline-block">
              {risk.reference_id}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {risk.title}
          </h2>
        </div>
        <Button variant="ghost" onClick={openEdit} className="shrink-0 h-9 px-3 text-xs">
          Edit
        </Button>
      </div>

      {/* Status / severity chips */}
      <div className="flex flex-wrap gap-2 py-2.5 border-b border-border-subtle">
        <Badge tone={statusTone(risk.status as RiskStatus)}>
          {risk.status}
        </Badge>
        <Severity level={risk.severity} />
        {risk.response_strategy && (
          <Badge tone={strategyTone(risk.response_strategy)}>
            {STRATEGY_LABEL[risk.response_strategy]}
          </Badge>
        )}
        {score != null && band && (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <Severity level={BAND_TO_SEVERITY[band]} />
            <span className="font-mono text-xs text-ink-muted tabular-nums">
              score {score}/5
            </span>
          </span>
        )}
      </div>

      {/* Fields */}
      <div>
        <DetailRow label="Project">
          <TextValue value={projectName} />
        </DetailRow>

        <DetailRow label="Owner">
          <TextValue value={ownerName} />
        </DetailRow>

        <DetailRow label="Due Date">
          <span className="tabular-nums">{formatDate(risk.due_date)}</span>
        </DetailRow>

        <DetailRow label="Likelihood">
          <Severity level={risk.likelihood} />
        </DetailRow>

        <DetailRow label="Probability">
          {risk.probability_pct != null ? (
            <span className="tabular-nums font-mono text-sm">{risk.probability_pct}%</span>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </DetailRow>

        <DetailRow label="Impact Score">
          {risk.impact_score != null ? (
            <span className="tabular-nums font-mono text-sm">{risk.impact_score}/5</span>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </DetailRow>

        <DetailRow label="Exposure Score">
          {score != null && band ? (
            <span className="inline-flex items-center gap-2">
              <Severity level={BAND_TO_SEVERITY[band]} />
              <span className="font-mono text-xs text-ink-muted tabular-nums">{score}/5</span>
            </span>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </DetailRow>

        <DetailRow label="Risk Category">
          <TextValue
            value={
              risk.risk_category
                ? (RISK_CATEGORY_LABELS[risk.risk_category] ?? risk.risk_category)
                : null
            }
          />
        </DetailRow>

        <DetailRow label="Impact Area">
          <TextValue
            value={
              risk.impact_area
                ? (IMPACT_AREA_LABELS[risk.impact_area] ?? risk.impact_area)
                : null
            }
          />
        </DetailRow>

        {risk.description && risk.description.trim() !== "" && (
          <DetailRow label="Description">
            <TextValue value={risk.description} />
          </DetailRow>
        )}

        {risk.mitigation && risk.mitigation.trim() !== "" && (
          <DetailRow label="Mitigation Plan">
            <TextValue value={risk.mitigation} />
          </DetailRow>
        )}

        <DetailRow label="Trigger / Early Warning">
          <TextValue value={risk.trigger} />
        </DetailRow>

        <DetailRow label="Residual Risk">
          <TextValue value={risk.residual_risk} />
        </DetailRow>
      </div>
    </div>
  );
}

// ── RiskRowButton — clickable <tr> wrapper (client component) ─────────────────

export function RiskRowButton({
  risk,
  projectName,
  ownerName,
  children,
}: RiskDetailProps & { children: React.ReactNode }) {
  const inspector = useInspector();

  function open() {
    inspector.open(
      <RiskDetail risk={risk} projectName={projectName} ownerName={ownerName} />,
      risk.reference_id ? `Risk ${risk.reference_id}` : "Risk Detail",
    );
  }

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="hover:bg-sunken transition-colors duration-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      {children}
    </tr>
  );
}

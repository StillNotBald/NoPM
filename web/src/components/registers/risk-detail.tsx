"use client";

import Link from "next/link";
import { History } from "lucide-react";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Button } from "@/components/ui/button";
import { EntityLink } from "@/components/ui/entity-link";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
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
  technical: "Technical",
  schedule: "Schedule",
  cost: "Cost / Funding",
  resourcing: "Resourcing",
  scope_requirements: "Scope / Requirements",
  supplier_external: "Supplier / External",
  regulatory_legal: "Regulatory / Legal",
  organisational: "Organisational / Change",
};

const IMPACT_AREA_LABELS: Record<string, string> = {
  schedule: "Schedule",
  cost: "Cost",
  scope: "Scope",
  quality: "Quality",
  reputation: "Reputation",
  compliance: "Compliance",
};


// ── RiskDetailRow — a labelled field row ──────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 border-b border-border-subtle last:border-0">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
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
  /** Same appearance preference the register list honours; absolute when omitted. */
  dateDisplayPref?: DateDisplayPref;
}

export function RiskDetail({ risk, projectName, ownerName, dateDisplayPref = "absolute" }: RiskDetailProps) {
  const inspector = useInspector();
  const formatDate = (iso: string | null | undefined) => formatByPref(iso, dateDisplayPref).text;

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
            <span className="font-mono text-[11px] bg-well border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted mb-1 inline-block">
              {risk.reference_id}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {risk.title}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Link
            href={`/trust?target_type=risk&target_id=${risk.id}`}
            className="focus-ring inline-flex h-11 items-center gap-1 rounded-md px-2 text-xs text-ink-secondary hover:bg-well hover:text-ink sm:h-9"
          >
            <History size={13} />
            History
          </Link>
          <Button variant="ghost" onClick={openEdit} className="h-11 px-3 text-xs sm:h-9">
            Edit
          </Button>
        </div>
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

// ── RiskDataList — responsive register list (F5): table ≥md, cards <md ───────

export type RiskListRow = RiskDetailProps["risk"] & { owner_id?: string | null };

export function RiskDataList({
  risks,
  projectMap,
  ownerMap,
  dateDisplayPref,
}: {
  risks: RiskListRow[];
  projectMap: Record<string, string>;
  ownerMap: Record<string, string>;
  dateDisplayPref: DateDisplayPref;
}) {
  const inspector = useInspector();

  function ownerName(ownerId: string | null | undefined) {
    if (!ownerId) return "—";
    return ownerMap[ownerId] ?? ownerId.slice(0, 8) + "…";
  }

  function openRisk(risk: RiskListRow) {
    inspector.open(
      <RiskDetail
        risk={risk}
        projectName={risk.project_id ? (projectMap[risk.project_id] ?? undefined) : undefined}
        ownerName={ownerName(risk.owner_id)}
        dateDisplayPref={dateDisplayPref}
      />,
      risk.reference_id ? `Risk ${risk.reference_id}` : "Risk Detail",
    );
  }

  const columns: DataListColumn<RiskListRow>[] = [
    {
      key: "ref",
      header: "Ref",
      // Desktop-only — Ref repeats redundantly with the card's own detail
      // panel one tap away, so it is dropped from the <md card, not the table.
      hideOnMobile: true,
      cell: (r) =>
        r.reference_id ? (
          <span className="font-mono text-xs bg-well border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted whitespace-nowrap">
            {r.reference_id}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (r) => (
        <span className="block min-w-0 max-w-[240px] truncate font-medium text-ink">{r.title}</span>
      ),
    },
    {
      key: "project",
      header: "Project",
      hideOnMobile: true,
      cell: (r) =>
        r.project_id ? (
          <span className="block min-w-0 max-w-[160px]">
            <EntityLink kind="project" id={r.project_id} muted>
              {projectMap[r.project_id] ?? "—"}
            </EntityLink>
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "severity",
      header: "Severity",
      badge: true,
      cell: (r) => <Severity level={r.severity} />,
    },
    {
      key: "score",
      header: "Score",
      badge: true,
      cell: (r) => {
        const score = riskScore(r.probability_pct ?? null, r.impact_score ?? null);
        const band = exposureBand(score);
        return score != null && band ? (
          <span className="inline-flex items-center gap-2">
            <Severity level={BAND_TO_SEVERITY[band]} />
            <span className="font-mono text-xs text-ink-muted tabular-nums">{score}/5</span>
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      },
    },
    {
      key: "strategy",
      header: "Strategy",
      badge: true,
      cell: (r) =>
        r.response_strategy ? (
          <Badge size="sm" tone={strategyTone(r.response_strategy)}>
            {STRATEGY_LABEL[r.response_strategy]}
          </Badge>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      badge: true,
      cell: (r) => (
        <Badge size="sm" tone={statusTone(r.status as RiskStatus)}>
          {r.status}
        </Badge>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      cell: (r) => <span className="text-xs text-ink-secondary">{ownerName(r.owner_id)}</span>,
    },
    {
      key: "due",
      header: "Due",
      cell: (r) => {
        const due = formatByPref(r.due_date, dateDisplayPref);
        return (
          <span className="tabular-nums text-xs text-ink-secondary" title={due.title}>
            {due.text}
          </span>
        );
      },
    },
  ];

  return (
    <DataList
      columns={columns}
      rows={risks}
      rowKey={(r) => r.id}
      onRowClick={openRisk}
      tableClassName="min-w-[860px]"
    />
  );
}

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { apiGet } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Spinner } from "@/components/ui/spinner";
import { EntityLink } from "@/components/ui/entity-link";
import { ragLabel, ragTone } from "@/lib/status";

// ── shapes (lenient — the dossier degrades gracefully if a field is absent) ──
export interface DossierProject {
  id: string;
  code: string;
  name: string;
  rag_status: string;
  completion_pct: number | null;
  program: string | null;
  target_date: string | null;
}
type Milestone = { id: string; name: string; status: string; target_date: string | null; completion_pct: number | null };
type RiskLite = { id: string; reference_id: string | null; title: string; severity: string; status: string };
type IssueLite = { id: string; reference_id: string | null; title: string; priority: string; status: string };
type Detail = { phase?: string | null; start_date?: string | null; target_date?: string | null; baseline_target_date?: string | null; currency?: string; is_locked?: boolean };
type AuditRow = { id: string; action: string; actor_label: string | null; actor_type: string | null; created_at: string };

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  not_started: "neutral", on_track: "success", at_risk: "warning", delayed: "danger", completed: "success",
};

function fmt(iso?: string | null) {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
}
function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}
function Module({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border-subtle pt-3.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{title}</h3>
        {count !== undefined && (
          <span className="rounded-full bg-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-muted">{count}</span>
        )}
      </div>
      {children}
    </section>
  );
}

export function ProjectDossier({ project, openR, openI }: { project: DossierProject; openR: number; openI: number }) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [risks, setRisks] = useState<RiskLite[]>([]);
  const [issues, setIssues] = useState<IssueLite[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  useEffect(() => {
    let cancel = false;
    const id = project.id;
    Promise.allSettled([
      apiGet<Detail>(`/api/projects/${id}`),
      apiGet<Milestone[]>(`/api/projects/${id}/milestones`),
      apiGet<RiskLite[]>(`/api/projects/${id}/risks`),
      apiGet<IssueLite[]>(`/api/projects/${id}/issues`),
      apiGet<AuditRow[]>(`/api/audit?target_type=project&target_id=${id}&limit=8`),
    ]).then((res) => {
      if (cancel) return;
      if (res[0].status === "fulfilled" && res[0].value) setDetail(res[0].value);
      if (res[1].status === "fulfilled") setMilestones((res[1].value ?? []).slice(0, 8));
      if (res[2].status === "fulfilled") setRisks((res[2].value ?? []).filter((r) => r.status === "open" || r.status === "mitigating"));
      if (res[3].status === "fulfilled") setIssues((res[3].value ?? []).filter((i) => i.status === "open" || i.status === "in_progress"));
      if (res[4].status === "fulfilled") setAudit(res[4].value ?? []);
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [project.id]);

  const pct = Math.min(100, Math.max(0, project.completion_pct ?? 0));
  const slip =
    detail?.baseline_target_date && detail?.target_date && detail.baseline_target_date !== detail.target_date;

  return (
    <div className="space-y-4 pb-4">
      {/* Header */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded border border-border-subtle bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {project.code}
          </span>
          <Badge size="sm" tone={ragTone(project.rag_status)}>{ragLabel(project.rag_status)}</Badge>
          {detail?.is_locked && <Badge size="sm" tone="warning">Locked</Badge>}
        </div>
        <h2 className="mt-1.5 text-base font-semibold leading-snug text-ink">{project.name}</h2>
        {project.program && <p className="text-xs text-ink-muted">{project.program}</p>}
        <div className="mt-2.5 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span className="w-9 text-right text-xs tabular-nums text-ink-secondary">{pct}%</span>
        </div>
      </div>

      <Module title="Status">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phase"><span className="capitalize">{detail?.phase ?? "—"}</span></Field>
          <Field label="Currency"><span className="font-mono text-xs">{detail?.currency ?? "—"}</span></Field>
          <Field label="Start"><span className="tabular-nums">{fmt(detail?.start_date)}</span></Field>
          <Field label="Target">
            <span className="tabular-nums">{fmt(detail?.target_date ?? project.target_date)}</span>
            {slip && (
              <span className="ml-1 text-[11px] text-danger-ink">(baseline {fmt(detail?.baseline_target_date)})</span>
            )}
          </Field>
          <Field label="Open risks">
            <span className={openR > 0 ? "font-medium text-danger-ink tabular-nums" : "text-ink-muted"}>{openR}</span>
          </Field>
          <Field label="Open issues">
            <span className={openI > 0 ? "font-medium text-warning-ink tabular-nums" : "text-ink-muted"}>{openI}</span>
          </Field>
        </div>
      </Module>

      <Module title="Milestones" count={milestones.length}>
        {milestones.length === 0 ? (
          <p className="text-sm text-ink-muted">No milestones.</p>
        ) : (
          <ul className="space-y-1.5">
            {milestones.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink">{m.name}</span>
                <Badge size="sm" tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status.replace(/_/g, " ")}</Badge>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-ink-muted">{fmt(m.target_date)}</span>
              </li>
            ))}
          </ul>
        )}
      </Module>

      <Module title="Open risks" count={risks.length}>
        {risks.length === 0 ? (
          <p className="text-sm text-ink-muted">None open.</p>
        ) : (
          <ul className="space-y-1.5">
            {risks.slice(0, 6).map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-sm">
                <Severity level={r.severity as "low" | "medium" | "high" | "critical"} />
                <EntityLink kind="risk" id={r.id} refId={r.reference_id} className="min-w-0 flex-1 text-sm">
                  {r.title}
                </EntityLink>
              </li>
            ))}
          </ul>
        )}
      </Module>

      <Module title="Open issues" count={issues.length}>
        {issues.length === 0 ? (
          <p className="text-sm text-ink-muted">None open.</p>
        ) : (
          <ul className="space-y-1.5">
            {issues.slice(0, 6).map((i) => (
              <li key={i.id} className="flex items-center gap-2 text-sm">
                <Badge size="sm" tone="warning">{i.priority}</Badge>
                <EntityLink kind="issue" id={i.id} refId={i.reference_id} className="min-w-0 flex-1 text-sm">
                  {i.title}
                </EntityLink>
              </li>
            ))}
          </ul>
        )}
      </Module>

      <Module title="Recent change history" count={audit.length}>
        {audit.length === 0 ? (
          <p className="text-sm text-ink-muted">No recorded changes.</p>
        ) : (
          <ul className="space-y-1.5">
            {audit.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-ink">{a.action}</span>
                <span className="min-w-0 flex-1 truncate text-ink-muted">
                  {a.actor_label ?? a.actor_type ?? "—"}
                </span>
                <span className="shrink-0 tabular-nums text-ink-muted">{ago(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Module>

      <div className="flex items-center justify-between border-t border-border-subtle pt-3">
        <a
          href={`/projects/${project.id}`}
          className="text-sm font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Open full project →
        </a>
        {loading && <Spinner size="sm" />}
      </div>
    </div>
  );
}

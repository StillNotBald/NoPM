import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { KpiTile } from "@/components/ui/kpi-tile";
import { CsvDownloadButton } from "@/components/budget/csv-download-button";
import { cn } from "@/lib/cn";
import { workspaceToday } from "@/lib/integrations/time-zone";
import { computeEvm, type EvmResult } from "@/lib/evm";
import { DEFAULT_WARN_PCT, OVERSPEND_AUDIT_ACTION, overspendLevel, type OverspendLevel } from "@/lib/insight/overspend";
import { EvmTable, BudgetTable, type EvmTableRow, type BudgetTableRow } from "@/components/budget/budget-tables";

interface ProjectBudget {
  project_id: string;
  planned_amount: number;
  committed_amount: number;
  currency: string | null;
  overspend_warn_pct?: number | null;
}

interface Project {
  id: string;
  name: string;
  currency: string | null;
  completion_pct: number | null;
  baseline_start_date: string | null;
  baseline_target_date: string | null;
}

interface ExpenseRow {
  project_id: string;
  amount: number;
}

interface BudgetRow {
  projectId: string;
  projectName: string;
  currency: string;
  planned: number;
  committed: number;
  actual: number;
  variance: number;
  burnPct: number;
  completionPct: number;
  evm: EvmResult;
  overspend: OverspendLevel;
  warnPct: number;
}

function fmtNum(amount: number): string {
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmt(amount: number, currency: string): string {
  return `${currency} ${fmtNum(amount)}`;
}

function fmtVariance(variance: number, currency: string): React.ReactNode {
  const formatted = fmt(Math.abs(variance), currency);
  if (variance < 0) {
    return <span className="text-danger-ink">-{formatted}</span>;
  }
  return <span className="text-success-ink">+{formatted}</span>;
}

// EVM index (CPI/SPI): ≥1 good (green), 0.9–1 watch (amber), <0.9 bad (red).
function indexTone(value: number | null): string {
  if (value === null) return "text-ink-muted";
  if (value >= 1) return "text-success-ink";
  if (value >= 0.9) return "text-warning-ink";
  return "text-danger-ink";
}

function fmtIndex(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

// VAC: positive (under budget) green, negative (over budget) red.
function vacTone(value: number | null): string {
  if (value === null) return "text-ink-muted";
  return value < 0 ? "text-danger-ink" : "text-success-ink";
}

export const metadata: Metadata = { title: "Budget" };

export default async function BudgetPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // Reporting date — used as the "as of" reference for schedule-based SPI.
  const { data: profile } = await db.from("profiles").select("workspace_id").eq("id", user.id).maybeSingle();
  if (!profile) redirect("/login");
  const asOfDate = await workspaceToday(profile.workspace_id);

  // Fetch all projects (include baseline dates for schedule-aware SPI)
  const { data: projects, error: projectsError } = await db
    .from("projects")
    .select("id, name, currency, completion_pct, baseline_start_date, baseline_target_date")
    .order("name");

  if (projectsError) {
    return <QueryError what="projects" message={projectsError.message} />;
  }

  const projectList = (projects ?? []) as Project[];
  const projectIds = projectList.map((p) => p.id);

  if (projectIds.length === 0) {
    return (
      <PageContainer width="wide" className="space-y-6">
        <div className="space-y-6">
          <PageHeader title="Budget" />
          <Card>
            <CardBody>
              <p className="text-sm text-ink-muted text-center py-6">
                No projects found. Create a project to track budgets.
              </p>
            </CardBody>
          </Card>
        </div>
      </PageContainer>
    );
  }

  // Fetch project_budget rows
  const { data: budgetRows, error: budgetError } = await db
    .from("project_budget")
    .select("project_id, planned_amount, committed_amount, currency, overspend_warn_pct")
    .in("project_id", projectIds);

  if (budgetError) return <QueryError what="budgets" message={budgetError.message} />;

  const budgetByProject: Record<string, ProjectBudget> = {};
  for (const b of (budgetRows ?? []) as ProjectBudget[]) {
    budgetByProject[b.project_id] = b;
  }

  // Fetch expenses grouped — sum amount per project
  const { data: expenses, error: expenseError } = await db
    .from("expenses")
    .select("project_id, amount")
    .in("project_id", projectIds);

  if (expenseError) return <QueryError what="expenses" message={expenseError.message} />;

  const expensesByProject: Record<string, number> = {};
  for (const exp of (expenses ?? []) as ExpenseRow[]) {
    if (exp.amount != null) {
      expensesByProject[exp.project_id] =
        (expensesByProject[exp.project_id] ?? 0) + exp.amount;
    }
  }

  // Build display rows
  const rows: BudgetRow[] = projectList.map((project) => {
    const budget = budgetByProject[project.id];
    const currency =
      budget?.currency ?? project.currency ?? "USD";
    const planned = budget?.planned_amount ?? 0;
    const committed = budget?.committed_amount ?? 0;
    const expenseCost = expensesByProject[project.id] ?? 0;
    const actual = expenseCost;
    const variance = planned - actual;
    const burnPct = planned > 0 ? (actual / planned) * 100 : 0;
    const completionPct = project.completion_pct ?? 0;
    const evm = computeEvm({
      planned_amount: planned,
      completion_pct: completionPct,
      committed_amount: committed,
      actual_amount: actual,
      baseline_start_date: project.baseline_start_date,
      baseline_target_date: project.baseline_target_date,
      as_of_date: asOfDate,
    });

    const warnPct = budget?.overspend_warn_pct ?? DEFAULT_WARN_PCT;
    return {
      overspend: overspendLevel(planned, actual, warnPct),
      warnPct,
      projectId: project.id,
      projectName: project.name,
      currency,
      planned,
      committed,
      actual,
      variance,
      burnPct,
      completionPct,
      evm,
    };
  });

  // Totals (use first currency or USD for display — mixed currencies show individually)
  const allSameCurrency =
    new Set(rows.map((r) => r.currency)).size <= 1;
  const totalCurrency = rows[0]?.currency ?? "USD";
  const totalPlanned = rows.reduce((s, r) => s + r.planned, 0);
  const totalCommitted = rows.reduce((s, r) => s + r.committed, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalVariance = totalPlanned - totalActual;
  const totalBurnPct = totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;

  // Portfolio EVM roll-up — completion weighted by BAC (planned) across projects.
  const totalEv = rows.reduce((s, r) => s + r.evm.ev, 0);
  const totalCompletionPct = totalPlanned > 0 ? (totalEv / totalPlanned) * 100 : 0;
  const portfolioEvm = computeEvm({
    planned_amount: totalPlanned,
    completion_pct: totalCompletionPct,
    committed_amount: totalCommitted,
    actual_amount: totalActual,
    as_of_date: asOfDate,
  });

  const overBudgetCount = rows.filter((r) => r.overspend === "over").length;
  const nearBudgetCount = rows.filter((r) => r.overspend === "warn").length;
  const alertRows = rows.filter((r) => r.overspend !== "ok");

  // Decision 19: the threshold crossings (one audit row each), newest first. Advisory only.
  const { data: crossingRows } = await db
    .from("audit_log")
    .select("id, created_at, target_id, before, after")
    .eq("action", OVERSPEND_AUDIT_ACTION)
    .in("target_id", projectIds)
    .order("created_at", { ascending: false })
    .limit(10);
  const nameById = new Map(projectList.map((p) => [p.id, p.name]));
  const crossings = (crossingRows ?? []) as {
    id: string;
    created_at: string;
    target_id: string;
    before: { level?: string } | null;
    after: { level?: string; burn_pct?: number } | null;
  }[];

  // Flatten to plain serializable rows for the (client) EvmTable/BudgetTable
  // DataList wrappers — DataList's column `cell` closures can't be passed
  // from this server component across the RSC boundary, so all display
  // formatting/tone decisions happen here.
  const evmTableRows: EvmTableRow[] = rows.map((row) => {
    const { cpi, spi, eac, vac } = row.evm;
    const worst = Math.min(cpi ?? 1, spi ?? 1);
    const dotToneClass =
      cpi === null && spi === null ? "bg-ink-muted" : worst < 0.9 ? "bg-danger" : worst < 1 ? "bg-warning" : "bg-success";
    return {
      projectId: row.projectId,
      projectName: row.projectName,
      completionPct: row.completionPct,
      dotToneClass,
      cpiDisplay: fmtIndex(cpi),
      cpiToneClass: indexTone(cpi),
      spiDisplay: fmtIndex(spi),
      spiToneClass: indexTone(spi),
      eacDisplay: eac === null ? "—" : fmt(eac, row.currency),
      vacDisplay: vac === null ? "—" : fmt(Math.abs(vac), row.currency),
      vacToneClass: vacTone(vac),
    };
  });
  // fmtVariance/fmt render JSX with the sign baked in for the page's own
  // table; the DataList row needs a plain string, so VAC/variance signs are
  // reapplied here to match fmtVariance's "+"/"-" convention exactly.
  for (let i = 0; i < rows.length; i++) {
    const vac = rows[i].evm.vac;
    if (vac !== null) {
      evmTableRows[i].vacDisplay = `${vac < 0 ? "-" : "+"}${evmTableRows[i].vacDisplay}`;
    }
  }

  // Figures only: each row names its currency once (beside the project), so the
  // number columns stay narrow enough for the register to fit without scrolling.
  const budgetTableRows: BudgetTableRow[] = rows.map((row) => {
    return {
      projectId: row.projectId,
      projectName: row.projectName,
      currency: row.currency,
      plannedDisplay: fmtNum(row.planned),
      committedDisplay: fmtNum(row.committed),
      actualDisplay: fmtNum(row.actual),
      varianceDisplay:
        row.planned === 0 ? null : `${row.variance < 0 ? "-" : "+"}${fmtNum(Math.abs(row.variance))}`,
      varianceIsNegative: row.variance < 0,
      burnPct: row.burnPct,
      completionPct: row.completionPct,
      hasPlan: row.planned > 0,
    };
  });

  const csvHeader = [
    "Project", "Currency", "Planned", "Committed", "Actual (expenses)", "Variance", "Burn %", "Completion %", "CPI", "SPI", "EAC", "VAC",
  ];
  const csvRows = rows.map((r) => [
    r.projectName, r.currency, r.planned, r.committed, r.actual, r.variance,
    Number(r.burnPct.toFixed(1)), Number(r.completionPct.toFixed(0)),
    r.evm.cpi === null ? null : Number(r.evm.cpi.toFixed(2)),
    r.evm.spi === null ? null : Number(r.evm.spi.toFixed(2)),
    r.evm.eac, r.evm.vac,
  ]);

  return (
    <PageContainer width="wide" className="space-y-6">
      <div className="space-y-6">
      <PageHeader
        title="Budget"
        exports={<CsvDownloadButton filename={`budget-${asOfDate}.csv`} header={csvHeader} rows={csvRows} />}
        action={
          (overBudgetCount > 0 || nearBudgetCount > 0) ? (
            <>
              {overBudgetCount > 0 && <Badge tone="danger">{overBudgetCount} over budget</Badge>}
              {nearBudgetCount > 0 && <Badge tone="warning">{nearBudgetCount} near limit</Badge>}
            </>
          ) : undefined
        }
      />

      {(alertRows.length > 0 || crossings.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Spend alerts</CardTitle>
            <span className="text-xs text-ink-muted">
              Warning at {alertRows[0]?.warnPct ?? DEFAULT_WARN_PCT}% of plan, over at 100%. Alerts never block spending.
            </span>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2 text-sm">
              {alertRows.map((r) => (
                <li key={r.projectId} className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.overspend === "over" ? "danger" : "warning"}>
                    {r.overspend === "over" ? "Over plan" : "Near limit"}
                  </Badge>
                  <span className="text-ink">{r.projectName}</span>
                  <span className="text-ink-muted tabular-nums">{r.burnPct.toFixed(1)}% of plan spent</span>
                </li>
              ))}
              {crossings.map((c) => (
                <li key={c.id} className="text-xs text-ink-muted">
                  {new Date(c.created_at).toISOString().slice(0, 10)} · {nameById.get(c.target_id) ?? "Project"} went{" "}
                  {c.before?.level ?? "ok"} to {c.after?.level ?? "ok"}
                  {c.after?.burn_pct != null ? ` (${c.after.burn_pct}% of plan)` : ""}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {/* Summary KPI row: planned / committed / actual / variance / burn */}
      <div className="grid grid-cols-2 gap-3 max-[359px]:grid-cols-1 sm:gap-4 lg:grid-cols-5 print:grid-cols-5">
        <KpiTile label="Planned" value={allSameCurrency ? fmt(totalPlanned, totalCurrency) : "—"} />
        <KpiTile label="Committed" value={allSameCurrency ? fmt(totalCommitted, totalCurrency) : "—"} />
        <KpiTile label="Actual (expenses)" value={allSameCurrency ? fmt(totalActual, totalCurrency) : "—"} />
        <KpiTile
          label="Variance"
          value={allSameCurrency ? `${totalVariance < 0 ? "-" : "+"}${fmt(Math.abs(totalVariance), totalCurrency)}` : "—"}
          sub={totalVariance < 0 ? "Over plan" : "Under plan"}
        />
        <KpiTile
          label="Burn"
          value={`${totalBurnPct.toFixed(1)}%`}
          sub={`${totalCompletionPct.toFixed(0)}% complete`}
        />
      </div>

      {/* Earned Value (EVM) strip — read-only cost-performance, computed from stored data */}
      <Card>
        <CardHeader>
          <CardTitle>Earned Value (EVM)</CardTitle>
          <span className="text-xs text-ink-muted">
            CPI = cost efficiency · SPI = schedule efficiency · ≥ 1.00 is good
          </span>
        </CardHeader>

        {/* Portfolio roll-up */}
        {allSameCurrency && (
          <div className="grid grid-cols-2 gap-3 max-[359px]:grid-cols-1 border-b border-border-subtle px-5 py-4 sm:gap-4 lg:grid-cols-4 [&>*]:min-w-0 [&_p]:break-words">
            <div>
              <p className="text-xs text-ink-muted uppercase tracking-wide">Portfolio CPI</p>
              <p className={cn("mt-1 text-lg font-semibold tabular-nums", indexTone(portfolioEvm.cpi))}>
                {fmtIndex(portfolioEvm.cpi)}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-muted uppercase tracking-wide">Portfolio SPI</p>
              <p className={cn("mt-1 text-lg font-semibold tabular-nums", indexTone(portfolioEvm.spi))}>
                {fmtIndex(portfolioEvm.spi)}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-muted uppercase tracking-wide">Forecast (EAC)</p>
              <p className="mt-1 text-lg font-semibold text-ink tabular-nums">
                {portfolioEvm.eac === null ? "—" : fmt(portfolioEvm.eac, totalCurrency)}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-muted uppercase tracking-wide">Variance (VAC)</p>
              <p className={cn("mt-1 text-lg font-semibold tabular-nums", vacTone(portfolioEvm.vac))}>
                {portfolioEvm.vac === null ? "—" : fmtVariance(portfolioEvm.vac, totalCurrency)}
              </p>
            </div>
          </div>
        )}

        {/* Per-project EVM */}
        <EvmTable rows={evmTableRows} />
      </Card>

      {/* Budget table */}
      <Card>
        <CardHeader>
          <CardTitle>Project Budgets</CardTitle>
          {!allSameCurrency && (
            <span className="text-xs text-ink-muted">Multiple currencies — totals not shown</span>
          )}
        </CardHeader>
        <BudgetTable
          rows={budgetTableRows}
          totals={
            allSameCurrency && rows.length > 1
              ? {
                  currency: totalCurrency,
                  plannedDisplay: fmtNum(totalPlanned),
                  committedDisplay: fmtNum(totalCommitted),
                  actualDisplay: fmtNum(totalActual),
                  varianceDisplay: `${totalVariance < 0 ? "-" : "+"}${fmtNum(Math.abs(totalVariance))}`,
                  varianceIsNegative: totalVariance < 0,
                  burnPct: totalBurnPct,
                  completionPct: totalCompletionPct,
                }
              : null
          }
        />
      </Card>
      </div>
    </PageContainer>
  );
}

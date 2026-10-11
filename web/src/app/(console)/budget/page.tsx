import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";
import { computeEvm, type EvmResult } from "@/lib/evm";
import { EvmTable, BudgetTable, type EvmTableRow, type BudgetTableRow } from "@/components/budget/budget-tables";

interface ProjectBudget {
  project_id: string;
  planned_amount: number;
  committed_amount: number;
  currency: string | null;
}

interface Project {
  id: string;
  name: string;
  currency: string | null;
  completion_pct: number | null;
  baseline_start_date: string | null;
  baseline_target_date: string | null;
}

interface TimeEntryRow {
  project_id: string;
  cost: number;
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
}

function fmt(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtVariance(variance: number, currency: string): React.ReactNode {
  const formatted = fmt(Math.abs(variance), currency);
  if (variance < 0) {
    return <span className="text-danger">-{formatted}</span>;
  }
  return <span className="text-success">+{formatted}</span>;
}

// EVM index (CPI/SPI): ≥1 good (green), 0.9–1 watch (amber), <0.9 bad (red).
function indexTone(value: number | null): string {
  if (value === null) return "text-ink-muted";
  if (value >= 1) return "text-success";
  if (value >= 0.9) return "text-warning";
  return "text-danger";
}

function fmtIndex(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

// VAC: positive (under budget) green, negative (over budget) red.
function vacTone(value: number | null): string {
  if (value === null) return "text-ink-muted";
  return value < 0 ? "text-danger" : "text-success";
}

export default async function BudgetPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // Reporting date — used as the "as of" reference for schedule-based SPI.
  const asOfDate = new Date().toISOString().slice(0, 10);

  // Fetch all projects (include baseline dates for schedule-aware SPI)
  const { data: projects, error: projectsError } = await db
    .from("projects")
    .select("id, name, currency, completion_pct, baseline_start_date, baseline_target_date")
    .order("name");

  if (projectsError) {
    return (
      <div className="px-4 py-5 sm:px-6 lg:px-8">
        <p className="text-sm text-danger">Failed to load projects.</p>
      </div>
    );
  }

  const projectList = (projects ?? []) as Project[];
  const projectIds = projectList.map((p) => p.id);

  if (projectIds.length === 0) {
    return (
      <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <PageHeader title="Budget" />
          <Card>
            <CardBody>
              <p className="text-sm text-ink-muted text-center py-6">
                No projects found. Create a project to track budgets.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  // Fetch project_budget rows
  const { data: budgetRows } = await db
    .from("project_budget")
    .select("project_id, planned_amount, committed_amount, currency")
    .in("project_id", projectIds);

  const budgetByProject: Record<string, ProjectBudget> = {};
  for (const b of (budgetRows ?? []) as ProjectBudget[]) {
    budgetByProject[b.project_id] = b;
  }

  // Fetch time_entries grouped — sum cost per project
  const { data: timeEntries } = await db
    .from("time_entries")
    .select("project_id, cost")
    .in("project_id", projectIds);

  const timeEntryCostByProject: Record<string, number> = {};
  for (const te of (timeEntries ?? []) as TimeEntryRow[]) {
    if (te.cost != null) {
      timeEntryCostByProject[te.project_id] =
        (timeEntryCostByProject[te.project_id] ?? 0) + te.cost;
    }
  }

  // Fetch expenses grouped — sum amount per project
  const { data: expenses } = await db
    .from("expenses")
    .select("project_id, amount")
    .in("project_id", projectIds);

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
    const timeCost = timeEntryCostByProject[project.id] ?? 0;
    const expenseCost = expensesByProject[project.id] ?? 0;
    const actual = timeCost + expenseCost;
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

    return {
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
  });

  const overBudgetCount = rows.filter((r) => r.burnPct > 100).length;
  const nearBudgetCount = rows.filter(
    (r) => r.burnPct >= 80 && r.burnPct <= 100,
  ).length;

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

  const budgetTableRows: BudgetTableRow[] = rows.map((row) => {
    const clamped = Math.min(row.burnPct, 100);
    const isOver = row.burnPct > 100;
    const isNear = row.burnPct >= 80 && !isOver;
    return {
      projectId: row.projectId,
      projectName: row.projectName,
      currency: row.currency,
      plannedDisplay: fmt(row.planned, row.currency),
      committedDisplay: fmt(row.committed, row.currency),
      actualDisplay: fmt(row.actual, row.currency),
      varianceDisplay:
        row.planned === 0 ? null : `${row.variance < 0 ? "-" : "+"}${fmt(Math.abs(row.variance), row.currency)}`,
      varianceIsNegative: row.variance < 0,
      burnPct: row.burnPct,
      burnClampedPct: clamped,
      isOver,
      isNear,
    };
  });

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Budget"
        action={
          (overBudgetCount > 0 || nearBudgetCount > 0) ? (
            <>
              {overBudgetCount > 0 && <Badge tone="danger">{overBudgetCount} over budget</Badge>}
              {nearBudgetCount > 0 && <Badge tone="warning">{nearBudgetCount} near limit</Badge>}
            </>
          ) : undefined
        }
      />

      {/* Summary cards — 2-col on phones, 1-col below 360px (long currency
          amounts wrap awkwardly in a ~140px cell on the smallest Android
          widths), 4-col at lg+ */}
      <div className="grid grid-cols-2 gap-3 max-[359px]:grid-cols-1 sm:gap-4 lg:grid-cols-4">
        <Card>
          <CardBody className="py-4">
            <p className="text-xs text-ink-muted uppercase tracking-wide">Total Planned</p>
            <p className="mt-1 text-lg font-semibold text-ink tabular-nums">
              {allSameCurrency ? fmt(totalPlanned, totalCurrency) : "—"}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="py-4">
            <p className="text-xs text-ink-muted uppercase tracking-wide">Committed</p>
            <p className="mt-1 text-lg font-semibold text-ink tabular-nums">
              {allSameCurrency ? fmt(totalCommitted, totalCurrency) : "—"}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="py-4">
            <p className="text-xs text-ink-muted uppercase tracking-wide">Actual Spend</p>
            <p className="mt-1 text-lg font-semibold text-ink tabular-nums">
              {allSameCurrency ? fmt(totalActual, totalCurrency) : "—"}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="py-4">
            <p className="text-xs text-ink-muted uppercase tracking-wide">Overall Burn</p>
            <p
              className={cn(
                "mt-1 text-lg font-semibold tabular-nums",
                totalBurnPct > 100
                  ? "text-danger"
                  : totalBurnPct >= 80
                  ? "text-warning"
                  : "text-accent",
              )}
            >
              {totalBurnPct.toFixed(1)}%
            </p>
          </CardBody>
        </Card>
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
          <div className="grid grid-cols-2 gap-3 max-[359px]:grid-cols-1 border-b border-border-subtle px-5 py-4 sm:gap-4 lg:grid-cols-4">
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
                  plannedDisplay: fmt(totalPlanned, totalCurrency),
                  committedDisplay: fmt(totalCommitted, totalCurrency),
                  actualDisplay: fmt(totalActual, totalCurrency),
                  varianceDisplay: `${totalVariance < 0 ? "-" : "+"}${fmt(Math.abs(totalVariance), totalCurrency)}`,
                  varianceIsNegative: totalVariance < 0,
                  burnPct: totalBurnPct,
                  burnClampedPct: Math.min(totalBurnPct, 100),
                }
              : null
          }
        />
      </Card>
      </div>
    </div>
  );
}

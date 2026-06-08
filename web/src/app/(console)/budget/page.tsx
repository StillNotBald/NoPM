import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";

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
}

function fmt(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-MY", {
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

export default async function BudgetPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // Fetch all projects
  const { data: projects, error: projectsError } = await db
    .from("projects")
    .select("id, name, currency")
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
      budget?.currency ?? project.currency ?? "MYR";
    const planned = budget?.planned_amount ?? 0;
    const committed = budget?.committed_amount ?? 0;
    const timeCost = timeEntryCostByProject[project.id] ?? 0;
    const expenseCost = expensesByProject[project.id] ?? 0;
    const actual = timeCost + expenseCost;
    const variance = planned - actual;
    const burnPct = planned > 0 ? (actual / planned) * 100 : 0;

    return {
      projectId: project.id,
      projectName: project.name,
      currency,
      planned,
      committed,
      actual,
      variance,
      burnPct,
    };
  });

  // Totals (use first currency or MYR for display — mixed currencies show individually)
  const allSameCurrency =
    new Set(rows.map((r) => r.currency)).size <= 1;
  const totalCurrency = rows[0]?.currency ?? "MYR";
  const totalPlanned = rows.reduce((s, r) => s + r.planned, 0);
  const totalCommitted = rows.reduce((s, r) => s + r.committed, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalVariance = totalPlanned - totalActual;
  const totalBurnPct = totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;

  const overBudgetCount = rows.filter((r) => r.burnPct > 100).length;
  const nearBudgetCount = rows.filter(
    (r) => r.burnPct >= 80 && r.burnPct <= 100,
  ).length;

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

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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

      {/* Budget table */}
      <Card>
        <CardHeader>
          <CardTitle>Project Budgets</CardTitle>
          {!allSameCurrency && (
            <span className="text-xs text-ink-muted">Multiple currencies — totals not shown</span>
          )}
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border-subtle">
                <th className="text-left px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                  Project
                </th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                  Planned
                </th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                  Committed
                </th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                  Actual
                </th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                  Variance
                </th>
                <th className="px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide min-w-[160px]">
                  Burn %
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((row) => {
                const clamped = Math.min(row.burnPct, 100);
                const isOver = row.burnPct > 100;
                const isNear = row.burnPct >= 80 && !isOver;

                return (
                  <tr
                    key={row.projectId}
                    className="hover:bg-sunken transition-colors duration-100"
                  >
                    {/* Project name */}
                    <td className="px-5 py-4">
                      <span className="font-medium text-ink">{row.projectName}</span>
                      <span className="ml-2 text-xs text-ink-muted">{row.currency}</span>
                    </td>

                    {/* Planned */}
                    <td className="px-5 py-4 text-right tabular-nums text-ink-secondary">
                      {fmt(row.planned, row.currency)}
                    </td>

                    {/* Committed */}
                    <td className="px-5 py-4 text-right tabular-nums text-ink-secondary">
                      {fmt(row.committed, row.currency)}
                    </td>

                    {/* Actual */}
                    <td className="px-5 py-4 text-right tabular-nums text-ink">
                      {fmt(row.actual, row.currency)}
                    </td>

                    {/* Variance */}
                    <td className="px-5 py-4 text-right tabular-nums font-medium">
                      {row.planned === 0 ? (
                        <span className="text-ink-muted">—</span>
                      ) : (
                        fmtVariance(row.variance, row.currency)
                      )}
                    </td>

                    {/* Burn % with bar */}
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        {/* Bar track */}
                        <div className="flex-1 h-2 rounded-full bg-sunken overflow-visible relative min-w-[80px]">
                          {/* Fill — capped at 100% visually */}
                          <div
                            className={cn(
                              "h-full rounded-full transition-all",
                              isOver
                                ? "bg-danger"
                                : isNear
                                ? "bg-warning"
                                : "bg-accent",
                            )}
                            style={{ width: `${clamped}%` }}
                          />
                          {/* Over-budget overflow indicator */}
                          {isOver && (
                            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2 h-3 rounded-sm bg-danger opacity-70" />
                          )}
                        </div>
                        {/* Label */}
                        <span
                          className={cn(
                            "tabular-nums text-xs font-medium w-12 text-right shrink-0",
                            isOver
                              ? "text-danger"
                              : isNear
                              ? "text-warning"
                              : "text-ink-secondary",
                          )}
                        >
                          {row.burnPct.toFixed(1)}%
                        </span>
                        {isOver && (
                          <Badge tone="danger" className="shrink-0">
                            Over
                          </Badge>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>

            {/* Totals footer */}
            {allSameCurrency && rows.length > 1 && (
              <tfoot>
                <tr className="border-t-2 border-border-subtle bg-sunken">
                  <td className="px-5 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">
                    Totals
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold text-ink">
                    {fmt(totalPlanned, totalCurrency)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold text-ink">
                    {fmt(totalCommitted, totalCurrency)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold text-ink">
                    {fmt(totalActual, totalCurrency)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold">
                    {fmtVariance(totalVariance, totalCurrency)}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2 rounded-full bg-canvas overflow-hidden min-w-[80px]">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            totalBurnPct > 100
                              ? "bg-danger"
                              : totalBurnPct >= 80
                              ? "bg-warning"
                              : "bg-accent",
                          )}
                          style={{ width: `${Math.min(totalBurnPct, 100)}%` }}
                        />
                      </div>
                      <span
                        className={cn(
                          "tabular-nums text-xs font-semibold w-12 text-right shrink-0",
                          totalBurnPct > 100
                            ? "text-danger"
                            : totalBurnPct >= 80
                            ? "text-warning"
                            : "text-accent",
                        )}
                      >
                        {totalBurnPct.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>
      </div>
    </div>
  );
}

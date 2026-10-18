"use client";

import { RequestDeletionControl } from "@/components/governance/request-deletion";

export type LedgerExpense = {
  id: string;
  project_id: string;
  description: string;
  amount: number;
  category: string | null;
  incurred_on: string;
};

/**
 * The expenses behind the "Actual" figures, one row each, so a wrong entry can be taken back (UAT-006).
 * An expense is a money record: removing it is a request a different person approves, never a direct delete.
 * Stacks as cards at phone width and is a table from sm up.
 */
export function ExpenseLedger({
  expenses,
  projectNames,
  currencies,
  canRequest,
}: {
  expenses: LedgerExpense[];
  projectNames: Record<string, string>;
  currencies: Record<string, string>;
  canRequest: boolean;
}) {
  if (expenses.length === 0) {
    return <p className="px-4 py-6 text-sm text-ink-muted">No expenses recorded yet.</p>;
  }
  const money = (e: LedgerExpense) =>
    `${currencies[e.project_id] ?? ""} ${Number(e.amount).toLocaleString("en-US", { maximumFractionDigits: 2 })}`.trim();

  return (
    <>
      <ul className="divide-y divide-border-subtle sm:hidden" aria-label="Expenses">
        {expenses.map((e) => (
          <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium text-ink">{e.description}</p>
              <p className="text-xs text-ink-muted">
                {projectNames[e.project_id] ?? "Project"} · {e.incurred_on}
                {e.category ? ` · ${e.category}` : ""}
              </p>
              <p className="mt-0.5 text-sm tabular-nums text-ink">{money(e)}</p>
            </div>
            {canRequest && (
              <RequestDeletionControl entity="expense" id={e.id} name={e.description} variant="icon" />
            )}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm" aria-label="Expenses">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs text-ink-muted">
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Project</th>
              <th className="px-4 py-2 font-medium">Description</th>
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.id} className="border-b border-border-subtle last:border-0">
                <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{e.incurred_on}</td>
                <td className="px-4 py-2 text-ink-secondary">{projectNames[e.project_id] ?? "Project"}</td>
                <td className="px-4 py-2 text-ink">{e.description}</td>
                <td className="px-4 py-2 text-ink-secondary">{e.category ?? ""}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink">{money(e)}</td>
                <td className="px-4 py-2 text-right">
                  {canRequest && (
                    <RequestDeletionControl entity="expense" id={e.id} name={e.description} variant="icon" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

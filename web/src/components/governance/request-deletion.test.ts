/**
 * UAT-006 / UAT-011: risks, issues, expenses and documents get the same "Request deletion" control as
 * milestones, with the reason dialog and the "Deletion requested" note. Static-markup render (no DOM).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/layout/app-shell", () => ({
  useInspector: () => ({ open() {}, close() {} }),
}));

import { RequestDeletionControl, RequestDeletionDialog } from "./request-deletion";
import { ExpenseLedger } from "@/components/budget/expense-ledger";
import { RiskDetail } from "@/components/registers/risk-detail";
import { IssueDetail } from "@/components/registers/issue-detail";

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("RequestDeletionControl", () => {
  it.each(["risk", "issue", "expense", "document"] as const)("%s: offers Request deletion", (entity) => {
    const html = render(createElement(RequestDeletionControl, { entity, id: "x1", name: "Thing" }));
    expect(html).toContain("Request deletion");
    expect(html).not.toContain("Deletion requested");
  });

  it("shows the Deletion requested note instead of the button while a request waits (UAT-011)", () => {
    const html = render(createElement(RequestDeletionControl, { entity: "risk", id: "x1", name: "Thing", requested: true }));
    expect(html).toContain("Deletion requested");
    expect(html).not.toContain("<button");
  });

  it("the icon form has an accessible name that says what it requests", () => {
    const html = render(createElement(RequestDeletionControl, { entity: "expense", id: "e1", name: "Hotel", variant: "icon" }));
    expect(html).toContain('aria-label="Request deletion of expense Hotel"');
  });
});

describe("RequestDeletionDialog", () => {
  const html = render(
    createElement(RequestDeletionDialog, { entity: "risk", name: "Vendor slips", onConfirm() {}, onCancel() {} }),
  );
  it("asks for a required reason and says a different person approves", () => {
    expect(html).toContain("Reason");
    expect(html).toContain('aria-required="true"');
    expect(html).toContain("different person");
    expect(html).toContain("Vendor slips");
  });
  it("stacks the buttons on a phone and sets them in a row from sm up, with 44px targets", () => {
    expect(html).toContain("flex-col-reverse");
    expect(html).toContain("sm:flex-row");
    expect(html).toContain("min-h-[44px]");
  });
});

describe("mounted on the panels", () => {
  it("the risk detail has the control", () => {
    const html = render(
      createElement(RiskDetail, {
        risk: { id: "r1", project_id: "p1", title: "Vendor slips", status: "open", severity: "high", likelihood: "medium" } as never,
      }),
    );
    expect(html).toContain("Request deletion");
  });

  it("the issue detail has the control", () => {
    const html = render(
      createElement(IssueDetail, {
        issue: { id: "i1", project_id: "p1", title: "Login fails", status: "open", priority: "high" } as never,
      }),
    );
    expect(html).toContain("Request deletion");
  });

  it("the expense ledger has a control per row, as cards on a phone and a table from sm up", () => {
    const html = render(
      createElement(ExpenseLedger, {
        expenses: [
          { id: "e1", project_id: "p1", description: "Hotel", amount: 500, category: null, incurred_on: "2026-10-01" },
          { id: "e2", project_id: "p1", description: "Taxi", amount: 20, category: "travel", incurred_on: "2026-10-02" },
        ],
        projectNames: { p1: "Apollo" },
        currencies: { p1: "MYR" },
        canRequest: true,
      }),
    );
    expect(html.match(/Request deletion of expense/g)?.length).toBe(4); // two rows x (card + table)
    expect(html).toContain("sm:hidden");
    expect(html).toContain("hidden overflow-x-auto sm:block");
    expect(html).toContain("MYR 500");
  });

  it("the document viewer and the budget page mount them", () => {
    expect(src("components/documents/document-viewer.tsx")).toContain('<RequestDeletionControl entity="document"');
    expect(src("app/(console)/budget/page.tsx")).toContain("<ExpenseLedger");
  });
});

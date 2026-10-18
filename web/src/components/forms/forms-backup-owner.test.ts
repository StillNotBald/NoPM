/** The four forms carry a labelled backup picker (M6, R-140). Static-markup render, as forms-a11y.test.ts. */
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { controlsIn, danglingLabels, unnamedControls } from "./a11y-markup";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/layout/app-shell", () => ({
  useInspector: () => ({ open() {}, close() {} }),
}));

import { IssueForm } from "./issue-form";
import { ProjectForm } from "./project-form";
import { RiskForm } from "./risk-form";
import { TaskForm } from "./task-form";

const PID = "11111111-1111-4111-8111-111111111111";
function html<P extends object>(component: ComponentType<P>, props: P) {
  return renderToStaticMarkup(createElement(component, props));
}

describe("backup owner picker on the forms", () => {
  const cases: Array<[string, string, string]> = [
    ["ProjectForm", html(ProjectForm, { mode: "create" }), "Backup owner"],
    ["RiskForm", html(RiskForm, { projectId: PID }), "Backup owner"],
    ["IssueForm", html(IssueForm, { projectId: PID }), "Backup owner"],
    ["TaskForm", html(TaskForm, { projectId: PID, milestones: [] }), "Backup assignee"],
  ];

  it.each(cases)("%s shows a labelled picker defaulting to no backup", (_n, markup, label) => {
    expect(markup).toContain(label);
    expect(markup).toContain("— No backup —");
    expect(unnamedControls(markup)).toEqual([]);
    expect(danglingLabels(markup)).toEqual([]);
    expect(controlsIn(markup).length).toBeGreaterThan(0);
  });
});

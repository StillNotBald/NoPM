/**
 * Server-render smoke tests for the create/edit forms.
 *
 * UI audit A3 measured 13 of 13 fields unlabeled on the Risk form: every form
 * used a sibling <label> with no `for`, and the title inputs were
 * placeholder-only. These render each form to static markup (no DOM
 * environment exists in this repo) and assert that every control now has an
 * accessible name, that each label points at a real control, and that
 * New Risk / New Issue carry a required Project picker instead of silently
 * filing under the first project.
 */
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

import { AllocationForm } from "./allocation-form";
import { Field, FieldError, TitleField, FormError } from "./project-form";
import { IssueForm } from "./issue-form";
import { MilestoneForm } from "./milestone-form";
import { ProgramForm } from "./program-form";
import { ProjectForm } from "./project-form";
import { ResourceForm } from "./resource-form";
import { RiskForm } from "./risk-form";
import { SprintForm } from "./sprint-form";
import { TaskForm } from "./task-form";
import { DocumentForm } from "@/components/documents/document-form";
import { LogTimeForm } from "@/components/timesheets/log-time-form";
import { Input } from "@/components/ui/input";

// Field's `children` is a required single element; createElement passes it positionally.
const FieldLoose = Field as unknown as ComponentType<Record<string, unknown>>;

const PROJECTS = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Alpha rollout" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Beta migration" },
];

function html<P extends object>(component: ComponentType<P>, props: P) {
  return renderToStaticMarkup(createElement(component, props));
}

describe("every form control has an accessible name", () => {
  const cases: Array<[string, string]> = [
    ["RiskForm", html(RiskForm, { projectId: PROJECTS[0].id })],
    ["RiskForm (register, with picker)", html(RiskForm, { projectId: "", projects: PROJECTS })],
    ["IssueForm", html(IssueForm, { projectId: PROJECTS[0].id })],
    ["IssueForm (register, with picker)", html(IssueForm, { projectId: "", projects: PROJECTS })],
    ["TaskForm", html(TaskForm, { projectId: PROJECTS[0].id, milestones: [] })],
    ["SprintForm", html(SprintForm, {})],
    ["ResourceForm", html(ResourceForm, {})],
    ["AllocationForm", html(AllocationForm, {})],
    ["MilestoneForm", html(MilestoneForm, { projectId: PROJECTS[0].id })],
    ["ProgramForm", html(ProgramForm, { mode: "create" })],
    ["ProjectForm", html(ProjectForm, { mode: "create" })],
    ["DocumentForm", html(DocumentForm, { projects: PROJECTS })],
    ["LogTimeForm", html(LogTimeForm, {})],
  ];

  it.each(cases)("%s", (_name, markup) => {
    expect(controlsIn(markup).length).toBeGreaterThan(0);
    expect(unnamedControls(markup).map((c) => c.attrs.trim().slice(0, 80))).toEqual([]);
    expect(danglingLabels(markup)).toEqual([]);
  });

  it("the Risk form's 13 content fields are all labelled (the audit's 13-of-13 case)", () => {
    const controls = controlsIn(cases[0][1]);
    // title + severity, likelihood, risk category, category, probability, impact score,
    // impact area, response strategy, status, due date, trigger, residual risk = 13
    expect(controls.length).toBeGreaterThanOrEqual(13);
    expect(controls.every((c) => c.namedBy)).toBe(true);
  });

  it("the title input is named even though its visible label is the placeholder", () => {
    const markup = html(RiskForm, { projectId: PROJECTS[0].id });
    expect(markup).toMatch(/aria-label="Risk title"/);
  });
});

describe("the Field primitive", () => {
  it("ties label, control and error together", () => {
    const markup = renderToStaticMarkup(
      createElement(
        FieldLoose,
        { label: "Due date", required: true, error: "Pick a date" },
        createElement(Input, { type: "date" }),
      ),
    );
    const forId = markup.match(/<label[^>]*for="([^"]+)"/)?.[1];
    expect(forId).toBeTruthy();
    expect(markup).toContain(`id="${forId}"`);
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-required="true"');
    const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBe(`${forId}-error`);
    expect(markup).toContain(`id="${forId}-error"`);
    expect(markup).toContain('role="alert"');
  });

  it("keeps an id the caller already gave the control", () => {
    const markup = renderToStaticMarkup(
      createElement(FieldLoose, { label: "Folder" }, createElement(Input, { id: "folder-input" })),
    );
    expect(markup).toContain('for="folder-input"');
    expect(markup).toContain('id="folder-input"');
  });

  it("adds no error wiring when there is no error", () => {
    const markup = renderToStaticMarkup(createElement(FieldLoose, { label: "Name" }, createElement(Input, {})));
    expect(markup).not.toContain("aria-invalid");
    expect(markup).not.toContain("aria-describedby");
    expect(markup).not.toContain("role=\"alert\"");
  });

  it("FieldError and FormError announce themselves", () => {
    expect(renderToStaticMarkup(createElement(FieldError, { message: "Required" }))).toContain('role="alert"');
    expect(renderToStaticMarkup(createElement(FormError, { message: "Boom" }))).toContain('role="alert"');
    expect(renderToStaticMarkup(createElement(FormError, { message: null }))).toBe("");
  });

  it("TitleField ties its error to the input", () => {
    const markup = renderToStaticMarkup(
      createElement(TitleField, { label: "Task name", placeholder: "Task name", error: "Task name is required" }),
    );
    expect(markup).toContain('aria-label="Task name"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toMatch(/aria-describedby="([^"]+)-error"/);
  });
});

describe("New Risk / New Issue never file under a project nobody chose", () => {
  const pickerOptions = (markup: string) =>
    [...markup.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);

  it("RiskForm from a register shows a required Project select listing every project, none preselected", () => {
    const markup = html(RiskForm, { projectId: "", projects: PROJECTS });
    expect(markup).toMatch(/>Project<span[^>]*>\*<\/span><\/label>/);
    const options = pickerOptions(markup);
    expect(options).toContainEqual(["", "— Select a project —"]);
    expect(options).toContainEqual([PROJECTS[0].id, "Alpha rollout"]);
    expect(options).toContainEqual([PROJECTS[1].id, "Beta migration"]);
    // the first project is NOT silently selected
    expect(markup).not.toMatch(new RegExp(`<option value="${PROJECTS[0].id}"[^>]*selected`));
  });

  it("opened with a project filter active, that project is preselected", () => {
    const markup = html(RiskForm, { projectId: PROJECTS[1].id, projects: PROJECTS });
    expect(markup).toMatch(new RegExp(`<option value="${PROJECTS[1].id}"[^>]*selected`));
  });

  it("a stale filter value that is not a known project is ignored", () => {
    const markup = html(IssueForm, { projectId: "99999999-9999-4999-8999-999999999999", projects: PROJECTS });
    expect(markup).toMatch(/<option value="" selected="">— Select a project —/);
    for (const p of PROJECTS) expect(markup).not.toMatch(new RegExp(`<option value="${p.id}"[^>]*selected`));
  });

  it("a workspace with a single project preselects it", () => {
    const markup = html(IssueForm, { projectId: "", projects: [PROJECTS[0]] });
    expect(markup).toMatch(new RegExp(`<option value="${PROJECTS[0].id}"[^>]*selected`));
  });

  it("IssueForm from a register shows the same required picker", () => {
    const markup = html(IssueForm, { projectId: "", projects: PROJECTS });
    expect(markup).toMatch(/>Project<span[^>]*>\*<\/span><\/label>/);
    expect(pickerOptions(markup)).toContainEqual([PROJECTS[1].id, "Beta migration"]);
  });

  it("a project page (no `projects`) keeps its fixed project and shows no picker", () => {
    expect(html(RiskForm, { projectId: PROJECTS[0].id })).not.toContain("Select a project");
    expect(html(IssueForm, { projectId: PROJECTS[0].id })).not.toContain("Select a project");
  });

  it("editing never offers to move a risk or issue to another project", () => {
    const risk = {
      id: "r1",
      project_id: PROJECTS[0].id,
      title: "Vendor slips",
      description: "",
      severity: "medium" as const,
      likelihood: "medium" as const,
      category: "",
      mitigation: "",
      status: "open" as const,
      raised_at: "2026-10-01T00:00:00Z",
      due_date: null,
    };
    expect(html(RiskForm, { projectId: risk.project_id, projects: PROJECTS, risk })).not.toContain(
      "Select a project",
    );
  });
});

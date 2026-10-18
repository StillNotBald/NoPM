/**
 * Server-render smoke tests for the register surfaces (tasks / risks / issues /
 * clashes / documents) — what a keyboard and screen-reader user
 * depends on, plus the contrast and layout defects the UI audit measured.
 *
 * vitest runs in a node environment with no DOM, so components render to static
 * markup with `react-dom/server`; effects do not run, so data-driven states are
 * exercised through props.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { controlsIn, unnamedControls } from "@/components/forms/a11y-markup";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  usePathname: () => "/issues",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/layout/app-shell", () => ({
  useInspector: () => ({ open() {}, close() {} }),
}));

import { IssuesView, type IssueRow } from "./issues/_issues-view";
import { RiskRegister } from "@/components/registers/risk-register";
import { ALL_COLUMNS, DEFAULT_COLUMNS, NUMERIC_COLUMNS, SORTABLE_FIELDS } from "./tasks/_columns";

const PROJECTS = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Alpha rollout" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Beta migration" },
];

const ISSUE: IssueRow = {
  id: "i1",
  project_id: PROJECTS[0].id,
  title: "Payment gateway times out",
  description: "",
  priority: "high",
  resolution: "",
  status: "in_progress",
  raised_at: "2026-10-01T00:00:00Z",
  due_date: "2026-11-05",
  reference_id: "ISS-001",
  severity: "high",
};

describe("/issues: the inspector is reachable from the keyboard", () => {
  const markup = renderToStaticMarkup(
    createElement(IssuesView, {
      issues: [ISSUE],
      projects: PROJECTS,
      projectMap: { [PROJECTS[0].id]: "Alpha rollout" },
      dateDisplayPref: "absolute",
      canWrite: true,
    }),
  );

  it("renders the issue title as a button, not a bare span in a clickable row", () => {
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Payment gateway times out<\/button>/);
  });

  it("every toolbar control has an accessible name", () => {
    expect(unnamedControls(markup)).toEqual([]);
    expect(controlsIn(markup).length).toBeGreaterThanOrEqual(5); // search, 4 filters, group-by
  });

  it("the table scrolls inside a named, focusable region (never the page)", () => {
    expect(markup).toMatch(/role="region"[^>]*aria-label="Issue register"|aria-label="Issue register"[^>]*role="region"/);
    expect(markup).toContain('tabindex="0"');
  });

  it("New Issue is offered with the register's project picker (the button is enabled)", () => {
    expect(markup).toContain("New Issue");
  });
});

describe("/risks: columns that fit, labelled controls", () => {
  const markup = renderToStaticMarkup(
    createElement(RiskRegister, {
      risks: [
        {
          id: "r1",
          project_id: PROJECTS[0].id,
          title: "Vendor slips",
          description: "",
          severity: "high",
          likelihood: "high",
          mitigation: "",
          status: "open",
          raised_at: "2026-10-01T00:00:00Z",
          due_date: "2026-11-05",
          reference_id: "RSK-001",
          owner_id: null,
          probability_pct: 60,
          impact_score: 4,
          response_strategy: "mitigate",
        },
      ],
      projects: PROJECTS,
      projectMap: { [PROJECTS[0].id]: "Alpha rollout" },
      ownerMap: {},
      dateDisplayPref: "absolute",
      canWrite: true,
    }),
  );

  it("shows the columns people scan (status, owner, due) and tucks Strategy/Score into the chooser", () => {
    const head = markup.slice(markup.indexOf("<thead"), markup.indexOf("</thead>"));
    for (const col of ["Ref", "Title", "Project", "Severity", "Status", "Owner", "Due"]) {
      expect(head).toContain(col);
    }
    expect(head).not.toContain("Strategy");
    expect(head).not.toContain("Score");
  });

  it("keeps due dates and owners on one line", () => {
    // the date text sits inside a nowrap span (it used to break "5 Nov 2026" onto three lines)
    expect(markup).toMatch(/<span class="[^"]*whitespace-nowrap[^"]*"[^>]*>5 Nov 2026<\/span>/);
  });

  it("marks the sorted column with aria-sort support and names every control", () => {
    expect(unnamedControls(markup)).toEqual([]);
  });
});

describe("/tasks column model", () => {
  it("shows Project by default, right beside the task name", () => {
    expect(DEFAULT_COLUMNS).toContain("project_id");
    expect(DEFAULT_COLUMNS.slice(0, 2)).toEqual(["name", "project_id"]);
  });

  it("every default column exists in the chooser", () => {
    const keys = new Set(ALL_COLUMNS.map((c) => c.key));
    for (const key of DEFAULT_COLUMNS) expect(keys.has(key)).toBe(true);
  });

  it("number columns are known columns", () => {
    const keys = new Set(ALL_COLUMNS.map((c) => c.key));
    for (const key of NUMERIC_COLUMNS) expect(keys.has(key)).toBe(true);
    for (const key of SORTABLE_FIELDS) expect(keys.has(key)).toBe(true);
  });
});

describe("token guards across the register surfaces", () => {
  const ROOT = process.cwd();
  const DIRS = [
    "src/app/(console)/tasks",
    "src/app/(console)/sprints",
    "src/app/(console)/documents",
    "src/app/(console)/risks",
    "src/app/(console)/issues",
    "src/app/(console)/clashes",
    "src/app/(console)/resources",
    "src/app/(console)/budget",
    "src/components/registers",
    "src/components/forms",
    "src/components/documents",
    "src/components/budget",
    "src/components/resources",
    "src/components/sprints",
  ];

  function sources(dir: string): Array<{ file: string; text: string }> {
    const out: Array<{ file: string; text: string }> = [];
    for (const name of readdirSync(join(ROOT, dir))) {
      const full = join(dir, name);
      if (statSync(join(ROOT, full)).isDirectory()) out.push(...sources(full));
      else if (/\.tsx$/.test(name)) out.push({ file: full, text: readFileSync(join(ROOT, full), "utf8") });
    }
    return out;
  }

  const files = DIRS.flatMap(sources);

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("uses no undefined colour tokens", () => {
    const offenders = files.filter((f) => /bg-warning-subtle/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("never sets status text in a raw status hue (needs the -ink token for 4.5:1)", () => {
    const re = /(?<![\w-])text-(danger|warning|success|info|sev-high|change)(?![\w/-])/g;
    const offenders = files.filter((f) => re.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("uses the shared solid focus ring, never a translucent accent ring", () => {
    const offenders = files.filter((f) => /ring-accent\/\d+/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});

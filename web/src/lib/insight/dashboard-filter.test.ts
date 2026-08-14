import { describe, it, expect } from "vitest";
import {
  hasActiveDashboardFilter,
  matchesDashboardFilters,
  filterDashboardProjects,
  dashboardFilterLabel,
  type DashboardFilterableProject,
} from "./dashboard-filter";

function project(
  id: string,
  program: string | null,
  targetDate: string | null,
): DashboardFilterableProject {
  return { id, program, target_date: targetDate };
}

describe("hasActiveDashboardFilter", () => {
  it("false for an empty filter set", () => {
    expect(hasActiveDashboardFilter({})).toBe(false);
  });

  it("true when any single field is set", () => {
    expect(hasActiveDashboardFilter({ program: "Core" })).toBe(true);
    expect(hasActiveDashboardFilter({ project: "p1" })).toBe(true);
    expect(hasActiveDashboardFilter({ dateFrom: "2026-01-01" })).toBe(true);
    expect(hasActiveDashboardFilter({ dateTo: "2026-12-31" })).toBe(true);
  });
});

describe("matchesDashboardFilters — no filters", () => {
  it("matches everything, including projects with null program/target_date", () => {
    expect(matchesDashboardFilters(project("p1", null, null), {})).toBe(true);
  });
});

describe("matchesDashboardFilters — program", () => {
  it("matches an exact program", () => {
    expect(matchesDashboardFilters(project("p1", "Core", null), { program: "Core" })).toBe(true);
  });

  it("rejects a different program", () => {
    expect(matchesDashboardFilters(project("p1", "Core", null), { program: "Platform" })).toBe(false);
  });

  it("rejects a null program when a program filter is set", () => {
    expect(matchesDashboardFilters(project("p1", null, null), { program: "Core" })).toBe(false);
  });
});

describe("matchesDashboardFilters — project", () => {
  it("matches by exact id only", () => {
    expect(matchesDashboardFilters(project("p1", null, null), { project: "p1" })).toBe(true);
    expect(matchesDashboardFilters(project("p2", null, null), { project: "p1" })).toBe(false);
  });
});

describe("matchesDashboardFilters — date range", () => {
  it("excludes a project with no target_date once any date bound is set", () => {
    expect(matchesDashboardFilters(project("p1", null, null), { dateFrom: "2026-01-01" })).toBe(false);
    expect(matchesDashboardFilters(project("p1", null, null), { dateTo: "2026-12-31" })).toBe(false);
  });

  it("is inclusive at both bounds", () => {
    const p = project("p1", null, "2026-06-01");
    expect(matchesDashboardFilters(p, { dateFrom: "2026-06-01", dateTo: "2026-06-01" })).toBe(true);
  });

  it("rejects a target_date outside a from/to window", () => {
    const p = project("p1", null, "2026-01-01");
    expect(matchesDashboardFilters(p, { dateFrom: "2026-02-01", dateTo: "2026-12-31" })).toBe(false);
  });

  it("supports an open-ended lower or upper bound", () => {
    const p = project("p1", null, "2026-06-15");
    expect(matchesDashboardFilters(p, { dateFrom: "2026-01-01" })).toBe(true);
    expect(matchesDashboardFilters(p, { dateTo: "2026-12-31" })).toBe(true);
    expect(matchesDashboardFilters(p, { dateFrom: "2027-01-01" })).toBe(false);
  });
});

describe("matchesDashboardFilters — combined (AND, not OR)", () => {
  it("requires every set field to match", () => {
    const p = project("p1", "Core", "2026-06-01");
    expect(matchesDashboardFilters(p, { program: "Core", project: "p1" })).toBe(true);
    expect(matchesDashboardFilters(p, { program: "Core", project: "other" })).toBe(false);
    expect(
      matchesDashboardFilters(p, { program: "Core", dateFrom: "2026-01-01", dateTo: "2026-12-31" }),
    ).toBe(true);
    expect(
      matchesDashboardFilters(p, { program: "Platform", dateFrom: "2026-01-01", dateTo: "2026-12-31" }),
    ).toBe(false);
  });
});

describe("filterDashboardProjects", () => {
  it("filters a list down to the matching subset, preserving order", () => {
    const projects = [
      project("p1", "Core", null),
      project("p2", "Platform", null),
      project("p3", "Core", null),
    ];
    const result = filterDashboardProjects(projects, { program: "Core" });
    expect(result.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("an empty filter set returns every project unchanged", () => {
    const projects = [project("p1", "Core", null), project("p2", null, null)];
    expect(filterDashboardProjects(projects, {})).toEqual(projects);
  });
});

describe("dashboardFilterLabel", () => {
  it("null when nothing is active — cards render no filter note", () => {
    expect(dashboardFilterLabel({})).toBeNull();
  });

  it("names the program", () => {
    expect(dashboardFilterLabel({ program: "Core" })).toBe("Program: Core");
  });

  it("names the project using the provided label, not the raw id", () => {
    expect(dashboardFilterLabel({ project: "p1" }, { projectLabel: "NP-001 — Atlas" })).toBe(
      "Project: NP-001 — Atlas",
    );
  });

  it("falls back to the raw id when no label was resolved", () => {
    expect(dashboardFilterLabel({ project: "p1" })).toBe("Project: p1");
  });

  it("names an open-ended date range with an ellipsis on the missing side", () => {
    expect(dashboardFilterLabel({ dateFrom: "2026-01-01" })).toBe("Target: 2026-01-01 – …");
    expect(dashboardFilterLabel({ dateTo: "2026-12-31" })).toBe("Target: … – 2026-12-31");
  });

  it("joins multiple active filters with a middle dot", () => {
    expect(dashboardFilterLabel({ program: "Core", dateFrom: "2026-01-01", dateTo: "2026-06-30" })).toBe(
      "Program: Core · Target: 2026-01-01 – 2026-06-30",
    );
  });
});

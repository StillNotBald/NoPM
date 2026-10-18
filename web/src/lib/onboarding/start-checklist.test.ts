import { describe, it, expect } from "vitest";
import {
  startSteps,
  progress,
  allDone,
  markStartVisited,
  setStartDismissed,
  MAX_VISITED,
  type StartChecklistInput,
} from "./start-checklist";

const BASE: StartChecklistInput = {
  projects: 0,
  tasks: 0,
  auditRows: 0,
  tokens: 0,
  members: 1,
  visited: [],
  role: "manager",
};

describe("startSteps — ordering and ids", () => {
  it("returns exactly 5 steps in the locked order", () => {
    const steps = startSteps(BASE);
    expect(steps.map((s) => s.id)).toEqual(["project", "task", "audit", "agent", "team"]);
  });

  it("every step has a non-empty title, caption, href, and cta", () => {
    for (const step of startSteps(BASE)) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.caption.length).toBeGreaterThan(0);
      expect(step.href.length).toBeGreaterThan(0);
      expect(step.cta.length).toBeGreaterThan(0);
    }
  });
});

describe("startSteps — done branches", () => {
  it("project: false when projects=0, true when projects>0", () => {
    expect(startSteps({ ...BASE, projects: 0 }).find((s) => s.id === "project")?.done).toBe(false);
    expect(startSteps({ ...BASE, projects: 3 }).find((s) => s.id === "project")?.done).toBe(true);
  });

  it("task: false when tasks=0, true when tasks>0", () => {
    expect(startSteps({ ...BASE, tasks: 0 }).find((s) => s.id === "task")?.done).toBe(false);
    expect(startSteps({ ...BASE, tasks: 5 }).find((s) => s.id === "task")?.done).toBe(true);
  });

  it("audit: false when visited doesn't include 'audit', true when it does", () => {
    expect(startSteps({ ...BASE, visited: [] }).find((s) => s.id === "audit")?.done).toBe(false);
    expect(startSteps({ ...BASE, auditRows: 500, visited: [] }).find((s) => s.id === "audit")?.done).toBe(
      false,
    );
    expect(startSteps({ ...BASE, visited: ["audit"] }).find((s) => s.id === "audit")?.done).toBe(true);
  });

  it("agent: false when tokens=0, true when tokens>0", () => {
    expect(startSteps({ ...BASE, tokens: 0 }).find((s) => s.id === "agent")?.done).toBe(false);
    expect(startSteps({ ...BASE, tokens: 1 }).find((s) => s.id === "agent")?.done).toBe(true);
  });

  it("team: false when members<=1, true when members>1", () => {
    expect(startSteps({ ...BASE, members: 1 }).find((s) => s.id === "team")?.done).toBe(false);
    expect(startSteps({ ...BASE, members: 2 }).find((s) => s.id === "team")?.done).toBe(true);
  });
});

describe("startSteps — href", () => {
  it("task step falls back to /projects with no firstProjectHref", () => {
    expect(startSteps(BASE).find((s) => s.id === "task")?.href).toBe("/projects");
  });

  it("task step uses firstProjectHref when given", () => {
    const steps = startSteps({ ...BASE, firstProjectHref: "/projects/abc" });
    expect(steps.find((s) => s.id === "task")?.href).toBe("/projects/abc");
  });

  it("agent step deep-links to the tokens connect-agent anchor", () => {
    expect(startSteps(BASE).find((s) => s.id === "agent")?.href).toBe("/tokens#connect-agent");
  });
});

describe("startSteps — canAct by role", () => {
  it("a manager (non-viewer) can act on every step", () => {
    for (const step of startSteps({ ...BASE, role: "manager" })) {
      expect(step.canAct).toBe(true);
    }
  });

  it("a viewer can act only on read steps", () => {
    for (const step of startSteps({ ...BASE, role: "viewer" })) {
      expect(step.canAct).toBe(step.kind === "read");
    }
  });
});

describe("progress", () => {
  it("0 of 5 when nothing is done", () => {
    expect(progress(startSteps(BASE))).toEqual({ done: 0, total: 5, pct: 0 });
  });

  it("counts done steps and computes a rounded percentage", () => {
    const steps = startSteps({ ...BASE, projects: 1, tasks: 1 });
    expect(progress(steps)).toEqual({ done: 2, total: 5, pct: 40 });
  });

  it("5 of 5 / 100% when every step is done", () => {
    const steps = startSteps({
      projects: 1,
      tasks: 1,
      auditRows: 1,
      tokens: 1,
      members: 2,
      visited: ["audit"],
      role: "manager",
    });
    expect(progress(steps)).toEqual({ done: 5, total: 5, pct: 100 });
  });
});

describe("allDone", () => {
  it("false when any step is undone", () => {
    expect(allDone(startSteps(BASE))).toBe(false);
  });

  it("true when every step is done", () => {
    const steps = startSteps({
      projects: 1,
      tasks: 1,
      auditRows: 1,
      tokens: 1,
      members: 2,
      visited: ["audit"],
      role: "manager",
    });
    expect(allDone(steps)).toBe(true);
  });
});

describe("markStartVisited", () => {
  it("adds a new id to an empty/undefined state", () => {
    expect(markStartVisited(undefined, "audit")).toEqual({ visited: ["audit"] });
  });

  it("appends without duplicating an existing id", () => {
    expect(markStartVisited({ visited: ["audit"] }, "audit")).toEqual({ visited: ["audit"] });
  });

  it("preserves dismissed alongside a new visit", () => {
    expect(markStartVisited({ dismissed: true, visited: [] }, "audit")).toEqual({
      dismissed: true,
      visited: ["audit"],
    });
  });

  it("caps the visited array at MAX_VISITED, evicting oldest first", () => {
    const bloated = Array.from({ length: MAX_VISITED }, (_, i) => `step-${i}`);
    const next = markStartVisited({ visited: bloated }, "new-step");
    expect(next.visited).toHaveLength(MAX_VISITED);
    expect(next.visited).not.toContain("step-0");
    expect(next.visited).toContain("new-step");
  });
});

describe("setStartDismissed", () => {
  it("sets dismissed true without disturbing visited", () => {
    expect(setStartDismissed({ visited: ["audit"] }, true)).toEqual({
      visited: ["audit"],
      dismissed: true,
    });
  });

  it("sets dismissed false (the Show toggle) from undefined state", () => {
    expect(setStartDismissed(undefined, false)).toEqual({ dismissed: false });
  });
});

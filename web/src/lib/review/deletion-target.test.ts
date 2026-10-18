import { describe, expect, it } from "vitest";
import { describeDeletionTarget, targetPhrase } from "./deletion-target";

describe("describeDeletionTarget", () => {
  it("names a task from its before snapshot, and finds its project", () => {
    expect(
      describeDeletionTarget({
        target_type: "task",
        target_id: "t-1",
        before: { name: "Cutover plan", project_id: "p-1", status: "started" },
      }),
    ).toEqual({ type: "task", name: "Cutover plan", projectId: "p-1" });
  });

  it("a project is its own project, named by its snapshot", () => {
    expect(
      describeDeletionTarget({ target_type: "project", target_id: "p-9", before: { name: "Apollo" } }),
    ).toEqual({ type: "project", name: "Apollo", projectId: "p-9" });
  });

  it("falls back to title, flattens whitespace and caps the length", () => {
    expect(describeDeletionTarget({ target_type: "task", target_id: "t", before: { title: "  Two\n lines  " } }).name).toBe(
      "Two lines",
    );
    const long = describeDeletionTarget({ target_type: "task", target_id: "t", before: { name: "x".repeat(500) } });
    expect(long.name?.length).toBe(120);
    expect(long.name?.endsWith("…")).toBe(true);
  });

  it("tolerates a missing or malformed snapshot (name null, never a throw)", () => {
    for (const before of [undefined, null, "oops", 7, [], {}]) {
      expect(describeDeletionTarget({ target_type: "task", target_id: "t-2", before })).toEqual({
        type: "task",
        name: null,
        projectId: null,
      });
    }
  });
});

describe("targetPhrase", () => {
  it("quotes the name, or gives just the type", () => {
    expect(targetPhrase({ type: "task", name: "Cutover plan" })).toBe("task “Cutover plan”");
    expect(targetPhrase({ type: "task", name: null })).toBe("task");
  });
});

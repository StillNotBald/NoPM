/**
 * R-176 (i): the Approvals page lists the five wave-5 kinds through the same pending query (it reads
 * deletion_requests of every target type), shows what approving also removes, and does not call a register
 * request "project locked". The pending API list is covered by lib/review/pending.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { childCountsHeading, describeChildCounts, describeDeletionTarget, showsChildCounts, targetPhrase } from "@/lib/review/deletion-target";
import { ChildCountsNote } from "@/components/review/child-counts-note";

const page = readFileSync(join(__dirname, "page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("what the approver is shown for the wave-5 registers", () => {
  it("program, sprint and resource show counts; allocation and clash have none", () => {
    for (const t of ["project", "milestone", "program", "sprint", "resource"]) expect(showsChildCounts(t)).toBe(true);
    for (const t of ["task", "risk", "allocation", "clash"]) expect(showsChildCounts(t)).toBe(false);
  });

  it("a program detaches its projects, a sprint its tasks, a resource deletes its allocations", () => {
    expect(childCountsHeading("program")).toBe("Approving also detaches:");
    expect(childCountsHeading("sprint")).toBe("Approving also detaches:");
    expect(childCountsHeading("resource")).toBe("Approving also deletes:");
    expect(describeChildCounts({ child_counts: { projects: 3 } }, "program")).toEqual([
      { key: "projects", label: "projects (kept, no longer in this program)", count: 3, governed: false },
    ]);
    expect(describeChildCounts({ child_counts: { tasks: 2 } }, "sprint")[0].label).toBe("tasks (kept, no longer in this sprint)");
    const res = describeChildCounts({ child_counts: { allocations: 2, allocation_ids: ["a", "b"], assigned_tasks: 1 } }, "resource");
    expect(res.map((l) => [l.key, l.count]).sort()).toEqual([["allocations", 2], ["assigned_tasks", 1]]);
  });

  it("the note renders the lines under the heading", () => {
    const html = renderToStaticMarkup(
      createElement(ChildCountsNote, {
        lines: describeChildCounts({ child_counts: { allocations: 2 } }, "resource"),
        heading: childCountsHeading("resource"),
      }),
    );
    expect(html).toContain("Approving also deletes:");
    expect(html).toContain("allocations");
  });

  it("names the record from the request snapshot (programs, sprints and resources have a name, clashes a title)", () => {
    expect(describeDeletionTarget({ target_type: "program", target_id: "p", before: { name: "Payments" } }).name).toBe("Payments");
    expect(describeDeletionTarget({ target_type: "clash", target_id: "c", before: { title: "Overlap" } }).name).toBe("Overlap");
    expect(targetPhrase({ type: "sprint", name: "Sprint 9" })).toBe("sprint “Sprint 9”");
  });
});

describe("the page", () => {
  it("reads every pending deletion request, whatever its type, so the new kinds appear without a type list", () => {
    expect(page).toMatch(/\.from\("deletion_requests"\)\s+\.select\("\*"\)\s+\.eq\("status", "pending"\)/);
    expect(page).not.toMatch(/target_type", \[/);
  });

  it("shows the counts note through showsChildCounts, not a project/milestone-only check", () => {
    expect(page).toContain("showsChildCounts(req.target_type)");
    expect(page).not.toContain('req.target_type === "project" || req.target_type === "milestone"');
  });

  it("does not treat a register request as blocked by a locked project (the commit does not check the lock)", () => {
    expect(page).toContain("isRegisterDeletionTarget(r.target_type)");
  });
});

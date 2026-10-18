import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createChangeRequestSchema } from "@/app/api/change-requests/_schema";
import { createRebaselineSchema } from "@/app/api/rebaselines/_schema";
import { TaskDeleteRequestSchema } from "@/app/api/tasks/_schema";
import { ProjectDeleteRequestSchema } from "@/app/api/projects/_schema";
import { resolveAssignedApprover } from "./assignee";

const UUID = "a0000000-0000-4000-8000-000000000002";
const API = resolve(__dirname, "../../app/api");

describe("assigned_approver_id on the raise schemas (G5)", () => {
  const cases: Array<[string, { safeParse: (v: unknown) => { success: boolean } }, Record<string, unknown>]> = [
    ["change request", createChangeRequestSchema, { title: "x" }],
    ["rebaseline", createRebaselineSchema, { reason: "x" }],
    ["task deletion", TaskDeleteRequestSchema, { reason: "x" }],
    ["project deletion", ProjectDeleteRequestSchema, { reason: "x" }],
  ];
  it.each(cases)("%s: optional, nullable, must be a uuid", (_name, schema, base) => {
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, assigned_approver_id: UUID }).success).toBe(true);
    expect(schema.safeParse({ ...base, assigned_approver_id: null }).success).toBe(true);
    expect(schema.safeParse({ ...base, assigned_approver_id: "nobody" }).success).toBe(false);
  });
});

describe("the four raise paths validate the assignee and audit it", () => {
  const files = [
    "projects/[id]/change-requests/route.ts",
    "projects/[id]/rebaselines/route.ts",
    "tasks/[id]/route.ts",
    "projects/[id]/route.ts",
  ];
  it.each(files)("%s resolves the assignee, stores it only when set, and records it", (f) => {
    const src = readFileSync(resolve(API, f), "utf8");
    expect(src).toMatch(/await resolveAssignedApprover\(/);
    expect(src).toMatch(/\.\.\.\(assignedApproverId \? \{ assigned_approver_id: assignedApproverId \} : \{\}\)/);
    // the audit row carries it: the CR and rebaseline audit the stored row, the deletions put it in `after`
    if (f.includes("tasks/") || f === "projects/[id]/route.ts") {
      expect(src).toMatch(/after: assignedApproverId \? \{ assigned_approver_id: assignedApproverId \} : null/);
    }
  });
});

describe("resolveAssignedApprover role rule", () => {
  const dbWith = (profile: Record<string, unknown> | null) =>
    ({
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) b[m] = () => b;
        b.maybeSingle = async () => ({ data: profile, error: null });
        return b;
      },
    }) as never;

  it("accepts admin and manager", async () => {
    for (const role of ["admin", "manager"]) {
      expect(await resolveAssignedApprover(dbWith({ id: UUID, role }), "w", UUID, "someone-else")).toBe(UUID);
    }
  });
  it.each(["member", "viewer", "guest"])("refuses a %s with 422", async (role) => {
    await expect(resolveAssignedApprover(dbWith({ id: UUID, role }), "w", UUID, "someone-else")).rejects.toMatchObject({
      status: 422,
      code: "invalid_assigned_approver",
    });
  });
  it("refuses a missing profile and the requester", async () => {
    await expect(resolveAssignedApprover(dbWith(null), "w", UUID, "someone-else")).rejects.toMatchObject({ status: 422 });
    await expect(resolveAssignedApprover(dbWith({ id: UUID, role: "admin" }), "w", UUID, UUID)).rejects.toMatchObject({ status: 422 });
  });
});

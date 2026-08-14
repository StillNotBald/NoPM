/**
 * Request-schema validation tests (consolidated).
 *
 * These Zod schemas are the API's first governance gate: everything downstream
 * (audit rows, RLS filters, the CLI/MCP contract) assumes the payload already
 * passed here. Each schema gets the same high-signal battery — minimal valid
 * payload, missing required field, bad enum, out-of-range number, and the
 * PATCH/partial variant — rather than exhaustive permutations.
 */
import { describe, it, expect } from "vitest";
import { TaskCreateSchema, TaskUpdateSchema, TaskDeleteRequestSchema } from "./tasks/_schema";
import { createRiskSchema, updateRiskSchema } from "./risks/_schema";
import { upsertBudgetSchema } from "./budget/_schema";
import {
  lockProjectSchema,
  createRebaselineSchema,
  signoffSchema,
} from "./rebaselines/_schema";
import {
  createProjectSchema,
  updateProjectSchema,
  ProjectDeleteRequestSchema,
} from "./projects/_schema";
import { createTokenSchema } from "./tokens/_schema";
import { SCOPES } from "@/lib/auth/scopes";

const UUID = "11111111-2222-4333-8444-555555555555";

/** Field paths reported by a failed parse, for asserting *which* field failed. */
function errorPaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) {
  return (result.error?.issues ?? []).map((i) => i.path.join("."));
}

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------
describe("TaskCreateSchema", () => {
  it("accepts a minimal payload and applies governance defaults", () => {
    const parsed = TaskCreateSchema.parse({ name: "Wire the audit stream" });
    expect(parsed).toMatchObject({
      name: "Wire the audit stream",
      status_type: "backlog",
      priority: "medium",
      completion_pct: 0,
    });
  });

  it("rejects a missing name", () => {
    const r = TaskCreateSchema.safeParse({ priority: "high" });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain("name");
  });

  it("rejects an empty name", () => {
    expect(TaskCreateSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects an invalid status_type enum value", () => {
    const r = TaskCreateSchema.safeParse({ name: "T", status_type: "done" });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain("status_type");
  });

  it("rejects an invalid priority enum value", () => {
    expect(TaskCreateSchema.safeParse({ name: "T", priority: "P0" }).success).toBe(false);
  });

  it.each([
    ["completion_pct", -1],
    ["completion_pct", 101],
    ["estimate_hours", -0.5],
    ["story_points", -3],
  ])("rejects a negative/out-of-range %s (%s)", (field, value) => {
    const r = TaskCreateSchema.safeParse({ name: "T", [field]: value });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain(field);
  });

  it("rejects a non-integer completion_pct", () => {
    expect(TaskCreateSchema.safeParse({ name: "T", completion_pct: 33.3 }).success).toBe(false);
  });

  it("rejects a non-UUID assignee_id but allows an explicit null (unassign)", () => {
    expect(TaskCreateSchema.safeParse({ name: "T", assignee_id: "alice" }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ name: "T", assignee_id: null }).success).toBe(true);
    expect(TaskCreateSchema.safeParse({ name: "T", assignee_id: UUID }).success).toBe(true);
  });

  it("validates checklist item shape", () => {
    expect(
      TaskCreateSchema.safeParse({
        name: "T",
        checklist: [{ id: "c1", text: "Write the migration", done: false }],
      }).success,
    ).toBe(true);
    // missing `done`
    expect(
      TaskCreateSchema.safeParse({ name: "T", checklist: [{ id: "c1", text: "x" }] }).success,
    ).toBe(false);
    // empty text
    expect(
      TaskCreateSchema.safeParse({ name: "T", checklist: [{ id: "c1", text: "", done: true }] })
        .success,
    ).toBe(false);
  });

  it("strips unknown keys rather than rejecting them (create is not .strict())", () => {
    const parsed = TaskCreateSchema.parse({ name: "T", workspace_id: "spoofed", id: "spoofed" });
    expect(parsed).not.toHaveProperty("workspace_id");
    expect(parsed).not.toHaveProperty("id");
  });
});

describe("TaskUpdateSchema", () => {
  it("accepts an empty object and any valid subset (true PATCH semantics)", () => {
    expect(TaskUpdateSchema.parse({})).toEqual({});
    expect(TaskUpdateSchema.parse({ status_type: "started" })).toEqual({ status_type: "started" });
    expect(TaskUpdateSchema.parse({ completion_pct: 100, priority: "urgent" })).toEqual({
      completion_pct: 100,
      priority: "urgent",
    });
  });

  it("applies no defaults on PATCH (an omitted field stays omitted)", () => {
    expect(TaskUpdateSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
  });

  it("rejects unknown keys (.strict) — a client cannot patch workspace_id or status via typo", () => {
    const r = TaskUpdateSchema.safeParse({ name: "T", workspace_id: "spoofed" });
    expect(r.success).toBe(false);
    expect(TaskUpdateSchema.safeParse({ statustype: "started" }).success).toBe(false);
  });

  it("rejects invalid values on the fields it does accept", () => {
    expect(TaskUpdateSchema.safeParse({ status_type: "done" }).success).toBe(false);
    expect(TaskUpdateSchema.safeParse({ completion_pct: 101 }).success).toBe(false);
    expect(TaskUpdateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(TaskUpdateSchema.safeParse({ milestone_id: "not-a-uuid" }).success).toBe(false);
  });
});

describe("TaskDeleteRequestSchema (maker-checker entry point)", () => {
  it("requires a non-empty reason", () => {
    expect(TaskDeleteRequestSchema.parse({ reason: "Duplicate of T-104" })).toEqual({
      reason: "Duplicate of T-104",
    });
    expect(TaskDeleteRequestSchema.safeParse({}).success).toBe(false);
    expect(TaskDeleteRequestSchema.safeParse({ reason: "" }).success).toBe(false);
  });

  it("caps the reason at 1000 characters", () => {
    expect(TaskDeleteRequestSchema.safeParse({ reason: "x".repeat(1001) }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// risks
// ---------------------------------------------------------------------------
describe("createRiskSchema", () => {
  const minimal = { title: "Vendor SLA slip", severity: "high", likelihood: "medium" };

  it("accepts a minimal payload and defaults status/response_strategy", () => {
    expect(createRiskSchema.parse(minimal)).toMatchObject({
      title: "Vendor SLA slip",
      severity: "high",
      likelihood: "medium",
      status: "open",
      response_strategy: "mitigate",
    });
  });

  it.each(["title", "severity", "likelihood"])("rejects a payload missing %s", (field) => {
    const payload: Record<string, unknown> = { ...minimal };
    delete payload[field];
    const r = createRiskSchema.safeParse(payload);
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain(field);
  });

  it.each([
    ["severity", "catastrophic"],
    ["likelihood", "unlikely"],
    ["status", "in_progress"],
    ["response_strategy", "ignore"],
    ["risk_category", "vibes"],
    ["impact_area", "morale"],
  ])("rejects an invalid %s enum value", (field, value) => {
    const r = createRiskSchema.safeParse({ ...minimal, [field]: value });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain(field);
  });

  it.each([
    ["probability_pct", -1],
    ["probability_pct", 101],
    ["probability_pct", 42.5],
    ["impact_score", 0],
    ["impact_score", 6],
  ])("rejects out-of-range %s = %s", (field, value) => {
    const r = createRiskSchema.safeParse({ ...minimal, [field]: value });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain(field);
  });

  it("accepts the boundary values for probability_pct and impact_score", () => {
    expect(createRiskSchema.safeParse({ ...minimal, probability_pct: 0, impact_score: 1 }).success).toBe(true);
    expect(createRiskSchema.safeParse({ ...minimal, probability_pct: 100, impact_score: 5 }).success).toBe(true);
  });

  it("requires an offset-bearing ISO datetime for raised_at / due_date", () => {
    expect(createRiskSchema.safeParse({ ...minimal, raised_at: "2026-08-13T09:00:00Z" }).success).toBe(true);
    expect(createRiskSchema.safeParse({ ...minimal, due_date: "2026-08-13" }).success).toBe(false);
    expect(createRiskSchema.safeParse({ ...minimal, due_date: "not a date" }).success).toBe(false);
  });

  it("rejects a non-UUID owner_id but allows null", () => {
    expect(createRiskSchema.safeParse({ ...minimal, owner_id: "priya" }).success).toBe(false);
    expect(createRiskSchema.safeParse({ ...minimal, owner_id: null }).success).toBe(true);
  });
});

describe("updateRiskSchema", () => {
  it("accepts an empty object and a valid subset, with no defaults injected", () => {
    expect(updateRiskSchema.parse({})).toEqual({});
    expect(updateRiskSchema.parse({ status: "closed" })).toEqual({ status: "closed" });
  });

  it("rejects invalid field values on the subset it receives", () => {
    expect(updateRiskSchema.safeParse({ severity: "catastrophic" }).success).toBe(false);
    expect(updateRiskSchema.safeParse({ impact_score: 9 }).success).toBe(false);
    expect(updateRiskSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("silently strips unknown keys (not .strict, unlike TaskUpdateSchema — see report)", () => {
    expect(updateRiskSchema.parse({ status: "closed", risk_score: 99 })).toEqual({ status: "closed" });
  });
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------
describe("upsertBudgetSchema", () => {
  it("accepts a minimal payload and defaults committed_amount and currency", () => {
    expect(upsertBudgetSchema.parse({ planned_amount: 250000 })).toEqual({
      planned_amount: 250000,
      committed_amount: 0,
      currency: "USD",
    });
  });

  it("rejects a missing planned_amount", () => {
    const r = upsertBudgetSchema.safeParse({ committed_amount: 100 });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain("planned_amount");
  });

  it.each([
    "planned_amount",
    "committed_amount",
    "actual_amount",
    "contingency_reserve",
    "management_reserve",
  ])("rejects a negative %s", (field) => {
    const r = upsertBudgetSchema.safeParse({ planned_amount: 100, [field]: -1 });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain(field);
  });

  it("accepts zero for every amount (nonnegative, not positive)", () => {
    expect(
      upsertBudgetSchema.safeParse({
        planned_amount: 0,
        committed_amount: 0,
        actual_amount: 0,
        contingency_reserve: 0,
        management_reserve: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects a numeric string amount (no coercion — the CLI must send real numbers)", () => {
    expect(upsertBudgetSchema.safeParse({ planned_amount: "250000" }).success).toBe(false);
  });

  it("bounds the currency string", () => {
    expect(upsertBudgetSchema.safeParse({ planned_amount: 1, currency: "" }).success).toBe(false);
    expect(upsertBudgetSchema.safeParse({ planned_amount: 1, currency: "x".repeat(11) }).success).toBe(false);
    expect(upsertBudgetSchema.safeParse({ planned_amount: 1, currency: "SGD" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rebaselines / lock / signoff (change control)
// ---------------------------------------------------------------------------
describe("createRebaselineSchema", () => {
  it("accepts a reason and optional before/after snapshots", () => {
    const parsed = createRebaselineSchema.parse({
      reason: "Scope change approved at CCB-14",
      before: { target_date: "2026-09-01" },
      after: { target_date: "2026-11-01" },
    });
    expect(parsed.reason).toBe("Scope change approved at CCB-14");
  });

  it("requires a non-empty reason (the audit trail must say why)", () => {
    expect(createRebaselineSchema.safeParse({}).success).toBe(false);
    expect(createRebaselineSchema.safeParse({ reason: "" }).success).toBe(false);
  });

  it("caps the reason at 2000 characters", () => {
    expect(createRebaselineSchema.safeParse({ reason: "x".repeat(2001) }).success).toBe(false);
    expect(createRebaselineSchema.safeParse({ reason: "x".repeat(2000) }).success).toBe(true);
  });
});

describe("signoffSchema", () => {
  it("accepts the two governed votes", () => {
    expect(signoffSchema.parse({ vote: "go" })).toEqual({ vote: "go" });
    expect(signoffSchema.parse({ vote: "no_go", comment: "Budget unresolved" })).toEqual({
      vote: "no_go",
      comment: "Budget unresolved",
    });
  });

  it("rejects a missing or invalid vote", () => {
    expect(signoffSchema.safeParse({}).success).toBe(false);
    expect(signoffSchema.safeParse({ vote: "abstain" }).success).toBe(false);
    expect(signoffSchema.safeParse({ vote: "GO" }).success).toBe(false);
  });

  it("caps the comment at 2000 characters", () => {
    expect(signoffSchema.safeParse({ vote: "go", comment: "x".repeat(2001) }).success).toBe(false);
  });
});

describe("lockProjectSchema", () => {
  it("accepts an empty body (reason optional) and a bounded reason", () => {
    expect(lockProjectSchema.parse({})).toEqual({});
    expect(lockProjectSchema.parse({ reason: "Baseline agreed" })).toEqual({ reason: "Baseline agreed" });
    expect(lockProjectSchema.safeParse({ reason: "x".repeat(1001) }).success).toBe(false);
  });

  it("rejects a non-string reason", () => {
    expect(lockProjectSchema.safeParse({ reason: 42 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------
describe("createProjectSchema", () => {
  const minimal = { code: "NOPM", name: "NoPM Platform" };

  it("accepts a minimal payload with no injected defaults", () => {
    expect(createProjectSchema.parse(minimal)).toEqual(minimal);
  });

  it.each(["code", "name"])("rejects a payload missing %s", (field) => {
    const payload: Record<string, unknown> = { ...minimal };
    delete payload[field];
    const r = createProjectSchema.safeParse(payload);
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain(field);
  });

  it("rejects empty or over-long code/name", () => {
    expect(createProjectSchema.safeParse({ ...minimal, code: "" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ ...minimal, code: "x".repeat(33) }).success).toBe(false);
    expect(createProjectSchema.safeParse({ ...minimal, name: "x".repeat(256) }).success).toBe(false);
  });

  it.each([
    ["rag_status", "yellow"],
    ["phase", "kickoff"],
  ])("rejects an invalid %s enum value", (field, value) => {
    const r = createProjectSchema.safeParse({ ...minimal, [field]: value });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain(field);
  });

  it("accepts every governed rag_status and phase value", () => {
    for (const rag of ["not_started", "red", "amber", "green", "complete"]) {
      expect(createProjectSchema.safeParse({ ...minimal, rag_status: rag }).success).toBe(true);
    }
    for (const phase of ["initiation", "planning", "execution", "monitoring", "closing"]) {
      expect(createProjectSchema.safeParse({ ...minimal, phase }).success).toBe(true);
    }
  });

  it("bounds completion_pct to 0..100", () => {
    expect(createProjectSchema.safeParse({ ...minimal, completion_pct: -1 }).success).toBe(false);
    expect(createProjectSchema.safeParse({ ...minimal, completion_pct: 101 }).success).toBe(false);
    expect(createProjectSchema.safeParse({ ...minimal, completion_pct: 0 }).success).toBe(true);
    expect(createProjectSchema.safeParse({ ...minimal, completion_pct: 100 }).success).toBe(true);
  });

  it("requires a 3-character currency code", () => {
    expect(createProjectSchema.safeParse({ ...minimal, currency: "US" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ ...minimal, currency: "USDD" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ ...minimal, currency: "SGD" }).success).toBe(true);
  });

  it("rejects a non-UUID owner_id", () => {
    expect(createProjectSchema.safeParse({ ...minimal, owner_id: "chu" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ ...minimal, owner_id: UUID }).success).toBe(true);
  });

  it("accepts null for the nullish charter fields", () => {
    expect(
      createProjectSchema.safeParse({ ...minimal, business_case: null, sponsor: null, objective: null })
        .success,
    ).toBe(true);
  });
});

describe("updateProjectSchema", () => {
  it("accepts an empty object and a valid subset", () => {
    expect(updateProjectSchema.parse({})).toEqual({});
    expect(updateProjectSchema.parse({ rag_status: "amber" })).toEqual({ rag_status: "amber" });
  });

  it("rejects invalid values on the subset it receives", () => {
    expect(updateProjectSchema.safeParse({ rag_status: "yellow" }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ completion_pct: 150 }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ currency: "DOLLARS" }).success).toBe(false);
  });

  it("strips is_locked — lock state can only change via the lock/unlock routes, never generic PATCH", () => {
    // Unknown key: zod's default (non-strict) object() silently strips it rather
    // than rejecting the request, so a stray is_locked in the body is a no-op.
    expect(updateProjectSchema.parse({ is_locked: true })).toEqual({});
    expect(updateProjectSchema.parse({ name: "Renamed", is_locked: true })).toEqual({
      name: "Renamed",
    });
    // Even a garbage (non-boolean) value is stripped, not validated — because
    // the schema no longer knows the key exists at all.
    expect(updateProjectSchema.safeParse({ is_locked: "yes" })).toEqual({
      success: true,
      data: {},
    });
  });
});

describe("ProjectDeleteRequestSchema (maker-checker entry point — Decision 3, devops-wave1)", () => {
  it("requires a non-empty reason", () => {
    expect(ProjectDeleteRequestSchema.parse({ reason: "Duplicate of FIN-MIG" })).toEqual({
      reason: "Duplicate of FIN-MIG",
    });
    expect(ProjectDeleteRequestSchema.safeParse({}).success).toBe(false);
    expect(ProjectDeleteRequestSchema.safeParse({ reason: "" }).success).toBe(false);
  });

  it("caps the reason at 1000 characters", () => {
    expect(ProjectDeleteRequestSchema.safeParse({ reason: "x".repeat(1001) }).success).toBe(false);
    expect(ProjectDeleteRequestSchema.safeParse({ reason: "x".repeat(1000) }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tokens (PAT minting — scopes validated against the central registry)
// ---------------------------------------------------------------------------
describe("createTokenSchema", () => {
  const minimal = { name: "ci-agent", scopes: ["project:read"] };

  it("accepts a minimal payload", () => {
    expect(createTokenSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects a missing/empty name", () => {
    expect(createTokenSchema.safeParse({ scopes: ["project:read"] }).success).toBe(false);
    expect(createTokenSchema.safeParse({ ...minimal, name: "" }).success).toBe(false);
    expect(createTokenSchema.safeParse({ ...minimal, name: "x".repeat(256) }).success).toBe(false);
  });

  it("requires at least one scope", () => {
    expect(createTokenSchema.safeParse({ ...minimal, scopes: [] }).success).toBe(false);
    expect(createTokenSchema.safeParse({ name: "ci-agent" }).success).toBe(false);
  });

  it("caps the scope list at 100", () => {
    const many = Array.from({ length: 101 }, () => "project:read");
    expect(createTokenSchema.safeParse({ ...minimal, scopes: many }).success).toBe(false);
  });

  it("accepts every scope in the central registry", () => {
    expect(createTokenSchema.safeParse({ name: "all", scopes: [...SCOPES] }).success).toBe(true);
  });

  it("accepts a <resource>:* wildcard for a known resource", () => {
    expect(createTokenSchema.safeParse({ ...minimal, scopes: ["task:*"] }).success).toBe(true);
  });

  it("rejects an unknown scope, so a bogus grant can never be minted", () => {
    const r = createTokenSchema.safeParse({ ...minimal, scopes: ["invoice:write"] });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain("scopes.0");
  });

  it("rejects a wildcard for an unknown resource", () => {
    expect(createTokenSchema.safeParse({ ...minimal, scopes: ["invoice:*"] }).success).toBe(false);
  });

  it("rejects the bare global * (defense in depth — it can no longer be minted)", () => {
    expect(createTokenSchema.safeParse({ ...minimal, scopes: ["*"] }).success).toBe(false);
  });

  it("rejects empty or whitespace-bearing scope strings", () => {
    expect(createTokenSchema.safeParse({ ...minimal, scopes: [""] }).success).toBe(false);
    expect(createTokenSchema.safeParse({ ...minimal, scopes: ["project: read"] }).success).toBe(false);
    expect(createTokenSchema.safeParse({ ...minimal, scopes: ["project:read "] }).success).toBe(false);
  });

  it("rejects one bad scope even when the rest are valid", () => {
    const r = createTokenSchema.safeParse({
      ...minimal,
      scopes: ["project:read", "task:write", "root:everything"],
    });
    expect(r.success).toBe(false);
    expect(errorPaths(r)).toContain("scopes.2");
  });

  it("requires an ISO-8601 datetime for expires_at when present", () => {
    expect(createTokenSchema.safeParse({ ...minimal, expires_at: "2027-01-01T00:00:00Z" }).success).toBe(true);
    expect(createTokenSchema.safeParse({ ...minimal, expires_at: "2027-01-01" }).success).toBe(false);
    expect(createTokenSchema.safeParse({ ...minimal, expires_at: "soon" }).success).toBe(false);
  });
});

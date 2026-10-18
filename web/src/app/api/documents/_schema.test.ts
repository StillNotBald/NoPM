import { describe, it, expect } from "vitest";
import { createDocumentSchema } from "./_schema";
import { createDecisionSchema } from "../decisions/_schema";
import { createChangeRequestSchema, decisionActionSchema } from "../change-requests/_schema";

describe("D18 length caps", () => {
  it("rejects over-long text on documents, decisions and change requests", () => {
    const long = "x".repeat(10_001);
    expect(createDocumentSchema.safeParse({ title: "t", doc_type: "plan", summary: long }).success).toBe(false);
    expect(createDocumentSchema.safeParse({ title: "t", doc_type: "plan", body: "x".repeat(100_001) }).success).toBe(false);
    expect(createDecisionSchema.safeParse({ title: "t", rationale: long }).success).toBe(false);
    expect(createChangeRequestSchema.safeParse({ title: "t", description: long }).success).toBe(false);
    expect(createChangeRequestSchema.safeParse({ title: "t", impact_cost: 1e13 }).success).toBe(false);
    expect(createChangeRequestSchema.safeParse({ title: "t", impact_schedule_days: 1e9 }).success).toBe(false);
    expect(decisionActionSchema.safeParse({ decision: "approve", rationale: long }).success).toBe(false);
  });
  it("still accepts ordinary values", () => {
    expect(createChangeRequestSchema.safeParse({ title: "t", description: "x".repeat(10_000), impact_cost: 5000.5 }).success).toBe(true);
  });
});

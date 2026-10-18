import { describe, it, expect } from "vitest";
import { MATERIAL_CHANGE_FIELDS, changedMaterialFields } from "./change-request-edit";
import { updateChangeRequestSchema } from "@/app/api/change-requests/_schema";

const existing = {
  title: "Extend go-live",
  description: "slip",
  category: "schedule",
  priority: "medium",
  impact_summary: "+4 weeks",
  impact_schedule_days: 28,
  impact_cost: 1000,
  target_date: "2027-01-31",
  raised_at: "2026-10-01T00:00:00Z",
};

describe("changedMaterialFields", () => {
  it("every updatable field is classified: material, or the one bookkeeping field (raised_at)", () => {
    const updatable = Object.keys(updateChangeRequestSchema.shape).sort();
    expect(updatable).toEqual([...MATERIAL_CHANGE_FIELDS, "raised_at"].sort());
  });

  it("flags each material field on its own", () => {
    const edits: Record<string, unknown> = {
      title: "Bigger",
      description: "more",
      category: "cost",
      priority: "critical",
      impact_summary: "+9 weeks",
      impact_schedule_days: 63,
      impact_cost: 9999,
      target_date: "2027-06-30",
    };
    for (const [field, value] of Object.entries(edits)) {
      expect(changedMaterialFields(existing, { [field]: value }), field).toEqual([field]);
    }
  });

  it("raised_at is not material", () => {
    expect(changedMaterialFields(existing, { raised_at: "2026-11-01T00:00:00Z" })).toEqual([]);
  });

  it("echoing stored values back is not a change, including '1000.00' vs 1000 and an ISO timestamp for the same day", () => {
    expect(
      changedMaterialFields(existing, {
        title: "Extend go-live",
        impact_cost: "1000.00",
        impact_schedule_days: 28,
        target_date: "2027-01-31T00:00:00Z",
      }),
    ).toEqual([]);
  });

  it("clearing a value is a change; clearing an already-empty one is not", () => {
    expect(changedMaterialFields(existing, { impact_cost: null })).toEqual(["impact_cost"]);
    expect(changedMaterialFields({ ...existing, impact_cost: null }, { impact_cost: null })).toEqual([]);
    expect(changedMaterialFields({ ...existing, description: null }, { description: "" })).toEqual([]);
  });

  it("an absent or undefined key is untouched", () => {
    expect(changedMaterialFields(existing, {})).toEqual([]);
    expect(changedMaterialFields(existing, { title: undefined })).toEqual([]);
  });

  it("several changes are all reported", () => {
    expect(changedMaterialFields(existing, { title: "x", impact_cost: 1 }).sort()).toEqual(["impact_cost", "title"]);
  });
});

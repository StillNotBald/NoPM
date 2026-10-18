/**
 * Create vs edit contract for the change-request form.
 *
 * Create posts to a route that only accepts raise-time statuses; edit patches
 * a route whose schema has no `status` at all. The form used to validate BOTH
 * against the create schema, which made editing an already-approved request
 * fail client-side. These tests pin the split: each mode is validated with the
 * schema its endpoint uses, create offers only raised / under_review, and an
 * edit never sends `status`.
 */
import { describe, expect, it } from "vitest";
import {
  RAISE_STATUS_OPTIONS,
  STATUS_LABEL,
  buildChangePayload,
  validateChangeForm,
  draftToImpactScope,
  impactCellText,
  impactScopeToDraft,
  type CRStatus,
  type ChangeFormValues,
} from "./change-form";

const ALL_STATUSES: CRStatus[] = ["raised", "under_review", "approved", "rejected", "deferred", "implemented"];

const values: ChangeFormValues = {
  title: "  Extend the pilot by two weeks  ",
  description: "",
  category: "schedule",
  priority: "high",
  status: "raised",
  impactSummary: "",
  impactScheduleDays: "14",
  impactCost: "",
  targetDate: "2026-11-30",
};

describe("create", () => {
  it("offers only the raise-time statuses, raised first", () => {
    expect([...RAISE_STATUS_OPTIONS]).toEqual(["raised", "under_review"]);
    for (const s of RAISE_STATUS_OPTIONS) expect(STATUS_LABEL[s]).toBeTruthy();
  });

  it("sends the chosen status and validates for both raise-time statuses", () => {
    for (const status of RAISE_STATUS_OPTIONS) {
      const result = validateChangeForm("create", { ...values, status });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.payload.status).toBe(status);
    }
  });

  it("builds a trimmed, null-normalised body", () => {
    expect(buildChangePayload("create", values)).toEqual({
      title: "Extend the pilot by two weeks",
      description: null,
      category: "schedule",
      priority: "high",
      status: "raised",
      impact_summary: null,
      impact_schedule_days: 14,
      impact_cost: null,
      target_date: "2026-11-30",
    });
  });

  it("still rejects a terminal status, as the API does (the UI never offers one)", () => {
    for (const status of ["approved", "rejected", "deferred"] as const) {
      const result = validateChangeForm("create", { ...values, status });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.status).toMatch(/raised or under_review/);
    }
  });

  it("flags a missing title and a fractional day count inline", () => {
    const result = validateChangeForm("create", { ...values, title: "   ", impactScheduleDays: "1.5" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.title).toBeTruthy();
      expect(result.errors.impact_schedule_days).toBeTruthy();
    }
  });
});

describe("edit", () => {
  it("never sends status", () => {
    expect(buildChangePayload("edit", values)).not.toHaveProperty("status");
    for (const status of ALL_STATUSES) {
      expect(buildChangePayload("edit", { ...values, status })).not.toHaveProperty("status");
    }
  });

  it("validates a change request in ANY status (regression: an approved request could not be edited)", () => {
    for (const status of ALL_STATUSES) {
      const result = validateChangeForm("edit", { ...values, status });
      expect(result.ok, `status ${status}`).toBe(true);
    }
  });

  it("validates against the update schema: the editable fields still have to be valid", () => {
    const bad = validateChangeForm("edit", {
      ...values,
      status: "approved",
      title: "",
      impactScheduleDays: "2.5",
      targetDate: "30/11/2026",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual(["impact_schedule_days", "target_date", "title"]);
      expect(bad.errors).not.toHaveProperty("status");
    }
  });

  it("sends the same editable fields as create, just without status", () => {
    const { status: _createOnly, ...create } = buildChangePayload("create", values);
    void _createOnly;
    expect(buildChangePayload("edit", values)).toEqual(create);
  });
});

describe("B2 - structured impact by area", () => {
  it("sends impact_scope when the form holds a list, null when it is emptied, nothing when untouched", () => {
    const list = [{ area: "scope" as const, direction: "increase" as const, note: null }];
    expect(buildChangePayload("create", { ...values, impactScope: list }).impact_scope).toEqual(list);
    expect(buildChangePayload("edit", { ...values, impactScope: [] }).impact_scope).toBeNull();
    expect(buildChangePayload("edit", values)).not.toHaveProperty("impact_scope");
  });

  it("round-trips through the per-area draft; an area left on Not affected is dropped", () => {
    const stored = [
      { area: "cost" as const, direction: "increase" as const, note: "licence" },
      { area: "quality" as const, direction: "neutral" as const, note: null },
    ];
    const draft = impactScopeToDraft(stored);
    expect(draft.scope.direction).toBe("");
    expect(draftToImpactScope(draft)).toEqual(stored);
  });

  it("validates the list with the same schema the endpoint uses", () => {
    const bad = validateChangeForm("create", {
      ...values,
      impactScope: [{ area: "scope", direction: "increase", note: null }, { area: "scope", direction: "decrease", note: null }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveProperty("impact_scope");
  });
});

describe("UAT-023 - Impact column falls back to the affected areas", () => {
  it("prefers the summary, then names the areas, then a dash", () => {
    expect(impactCellText({ impact_summary: "Two more screens", impact_scope: null })).toBe("Two more screens");
    expect(
      impactCellText({
        impact_summary: null,
        impact_scope: [
          { area: "scope", direction: "increase", note: null },
          { area: "cost", direction: "decrease", note: null },
        ],
      }),
    ).toBe("Scope up, Cost down");
    expect(impactCellText({ impact_summary: "  ", impact_scope: [] })).toBe("—");
  });
});

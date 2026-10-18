/**
 * UAT-004 / UAT-005 / UAT-010: the raise form sends the tier, the emergency flag and the approver; the
 * tier and deadline are always shown; the approval policy card lives on Settings.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChangePayload, canRaiseEmergency, tierOptions, validateChangeForm, type ChangeFormValues } from "./change-form";

const base: ChangeFormValues = {
  title: "Move go-live",
  description: "",
  category: "scope",
  priority: "medium",
  status: "raised",
  impactSummary: "",
  impactScheduleDays: "",
  impactCost: "",
  targetDate: "",
};

describe("UAT-004: tier, emergency and approver in the request body (create only)", () => {
  it("automatic tier sends nothing, so the server decides", () => {
    const body = buildChangePayload("create", { ...base, tier: "" });
    expect(body).not.toHaveProperty("tier");
    expect(body).not.toHaveProperty("is_emergency");
    expect(body).not.toHaveProperty("assigned_approver_id");
  });

  it("a chosen tier is sent", () => {
    expect(buildChangePayload("create", { ...base, tier: "high_risk" }).tier).toBe("high_risk");
  });

  it("the emergency tick sends is_emergency and no tier (the server rejects a plain emergency tier)", () => {
    const body = buildChangePayload("create", { ...base, tier: "high_risk", isEmergency: true });
    expect(body.is_emergency).toBe(true);
    expect(body).not.toHaveProperty("tier");
  });

  it("an approver is sent when picked", () => {
    expect(buildChangePayload("create", { ...base, assignedApproverId: "a0000000-0000-4000-8000-000000000002" }).assigned_approver_id).toBe(
      "a0000000-0000-4000-8000-000000000002",
    );
  });

  it("an edit never sends tier, emergency or approver (the tier is the server's to raise, never lower)", () => {
    const body = buildChangePayload("edit", { ...base, tier: "high_risk", isEmergency: true, assignedApproverId: "x" });
    expect(body).not.toHaveProperty("tier");
    expect(body).not.toHaveProperty("is_emergency");
    expect(body).not.toHaveProperty("assigned_approver_id");
  });

  it("the create schema accepts every body the form can build", () => {
    for (const v of [
      { ...base },
      { ...base, tier: "routine" as const },
      { ...base, tier: "strategic" as const },
      { ...base, isEmergency: true },
      { ...base, assignedApproverId: "a0000000-0000-4000-8000-000000000002" },
    ]) {
      expect(validateChangeForm("create", v).ok).toBe(true);
    }
  });

  it("an approver that is not an id is refused before the network", () => {
    expect(validateChangeForm("create", { ...base, assignedApproverId: "not-an-id" }).ok).toBe(false);
  });
});

describe("tier choices", () => {
  const none = { hasCost: false, hasDays: false, hasScope: false };
  const find = (o: ReturnType<typeof tierOptions>, v: string) => o.find((x) => x.value === v);

  it("Routine is offered only with no cost, schedule or scope impact", () => {
    expect(find(tierOptions({ role: "manager", ...none }), "routine")?.disabled).toBeFalsy();
    for (const k of ["hasCost", "hasDays", "hasScope"] as const) {
      expect(find(tierOptions({ role: "manager", ...none, [k]: true }), "routine")?.disabled).toBe(true);
    }
  });

  it("Strategic is offered to an admin only", () => {
    expect(find(tierOptions({ role: "admin", ...none }), "strategic")).toBeTruthy();
    expect(find(tierOptions({ role: "manager", ...none }), "strategic")).toBeUndefined();
    expect(find(tierOptions({ role: null, ...none }), "strategic")).toBeUndefined();
  });

  it("the first choice is Automatic", () => {
    expect(tierOptions({ role: "member", ...none })[0]).toMatchObject({ value: "", label: expect.stringContaining("Automatic") });
  });

  it("only a manager or admin may tick Emergency", () => {
    expect(canRaiseEmergency("admin")).toBe(true);
    expect(canRaiseEmergency("manager")).toBe(true);
    for (const r of ["member", "viewer", null, undefined]) expect(canRaiseEmergency(r)).toBe(false);
  });
});

describe("UAT-005 / UAT-010: where things are shown", () => {
  const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

  it("change detail shows the tier for a Normal request too, and the decision deadline", () => {
    const s = src("components/change-control/change-detail.tsx");
    expect(s).toMatch(/cr\.tier && cr\.tier !== "emergency"/);
    expect(s).not.toMatch(/cr\.tier !== "normal"/);
    expect(s).toContain('label="Decision due"');
  });

  it("the review queue row shows tier and the deadline, with overdue styling", () => {
    const s = src("components/review/queue-list.tsx");
    expect(s).toContain("item.tier");
    expect(s).toMatch(/overdue since/);
  });

  it("the review queue carries tier and deadline for deletions, rebaselines and change requests", () => {
    const s = src("lib/review/gather.ts");
    expect(s.match(/\.\.\.tierFields\(row\)/g)?.length).toBe(3);
  });

  it("the Approval policy card is on Settings and no longer on Integrations", () => {
    expect(src("app/(console)/settings/page.tsx")).toContain("<ApprovalPolicyCard");
    expect(src("components/integrations/integrations-console.tsx")).not.toContain("ApprovalPolicyCard");
  });
});

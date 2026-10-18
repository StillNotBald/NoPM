import { describe, it, expect } from "vitest";
import { FieldsError, ScopeError } from "@/lib/api/errors";
import {
  DEFAULT_POLICY,
  approverRoleFor,
  classify,
  deadlineFor,
  eligibleRoles,
  humanRoleOf,
  isAwaitingRetro,
  isRetroOverdue,
  mergePolicy,
  policyOf,
  reclassifyOnEdit,
  reminderDueAt,
  requireTierRole,
  retroDueAt,
  roleMeetsTier,
  tierOf,
  validatePolicyInput,
} from "./tiers";

const policy = policyOf({});
const base = { kind: "change_request" as const, policy, requester_role: "manager" };

describe("policyOf: the CR A3 defaults", () => {
  it("an empty policy is the defaults: routine and normal -> manager, high_risk and strategic -> admin, emergency retro -> admin", () => {
    expect(approverRoleFor("routine", policy)).toBe("manager");
    expect(approverRoleFor("normal", policy)).toBe("manager");
    expect(approverRoleFor("high_risk", policy)).toBe("admin");
    expect(approverRoleFor("emergency", policy)).toBe("admin");
    expect(approverRoleFor("strategic", policy)).toBe("admin");
    expect(policy.currency_threshold).toBe(50_000);
    expect(policy.emergency_retro_hours).toBe(48);
  });

  it("auto-approve is OFF by default on every tier", () => {
    for (const t of Object.values(policy.tiers)) expect(t.auto_approve).toBe(false);
  });

  it("a stored value overrides only what it names; garbage falls back to the default", () => {
    const p = policyOf({
      tiers: { normal: { approver_role: "admin", turnaround_hours: 12 }, high_risk: { approver_role: "root", turnaround_hours: -4 } },
      currency_threshold: "lots",
      emergency_retro_hours: 0,
    });
    expect(p.tiers.normal).toMatchObject({ approver_role: "admin", turnaround_hours: 12 });
    expect(p.tiers.high_risk).toMatchObject({ approver_role: "admin", turnaround_hours: DEFAULT_POLICY.tiers.high_risk.turnaround_hours });
    expect(p.currency_threshold).toBe(50_000);
    expect(p.emergency_retro_hours).toBe(48);
  });

  it("auto_approve is honoured for routine only, whatever a hand-edited row says", () => {
    const p = policyOf({ tiers: { routine: { auto_approve: true }, normal: { auto_approve: true }, high_risk: { auto_approve: true } } });
    expect(p.tiers.routine.auto_approve).toBe(true);
    expect(p.tiers.normal.auto_approve).toBe(false);
    expect(p.tiers.high_risk.auto_approve).toBe(false);
  });

  it("tierOf reads a legacy row (no tier) as normal", () => {
    expect(tierOf({})).toBe("normal");
    expect(tierOf(null)).toBe("normal");
    expect(tierOf({ tier: "high_risk" })).toBe("high_risk");
    expect(tierOf({ tier: "bogus" })).toBe("normal");
  });
});

describe("classify (G1, G7)", () => {
  it("a plain change request is normal", () => {
    expect(classify({ ...base })).toMatchObject({ tier: "normal", threshold_bump: false });
  });

  it("G7: a cost at or over the threshold lifts normal to high_risk, either sign; just under stays normal", () => {
    expect(classify({ ...base, impact_cost: 49_999.99 }).tier).toBe("normal");
    expect(classify({ ...base, impact_cost: 50_000 })).toMatchObject({ tier: "high_risk", threshold_bump: true });
    expect(classify({ ...base, impact_cost: -80_000 }).tier).toBe("high_risk");
  });

  it("G7: the threshold is the workspace's, not a constant", () => {
    const p = policyOf({ currency_threshold: 1_000 });
    expect(classify({ ...base, policy: p, impact_cost: 1_000 }).tier).toBe("high_risk");
    expect(classify({ ...base, policy: policyOf({ currency_threshold: 1_000_000 }), impact_cost: 500_000 }).tier).toBe("normal");
  });

  it("W4-06: the currency is a label (default MYR); costs are compared as plain numbers, nothing is converted", () => {
    expect(policy.currency).toBe("MYR");
    expect(policyOf({ currency: null }).currency).toBeNull();
    expect(classify({ ...base, impact_cost: 10 }).tier).toBe("normal");
    expect(classify({ ...base, impact_cost: 50_000 }).tier).toBe("high_risk");
  });

  it("W4-06: a schedule impact of more than the days threshold (default 10) lifts normal to high_risk, either sign", () => {
    expect(policy.schedule_threshold_days).toBe(10);
    expect(classify({ ...base, impact_schedule_days: 10 }).tier).toBe("normal");
    expect(classify({ ...base, impact_schedule_days: 11 })).toMatchObject({ tier: "high_risk", threshold_bump: true });
    expect(classify({ ...base, impact_schedule_days: -30 }).tier).toBe("high_risk");
    expect(classify({ ...base, policy: policyOf({ schedule_threshold_days: 2 }), impact_schedule_days: 3 }).tier).toBe("high_risk");
    expect(policyOf({ schedule_threshold_days: -1 }).schedule_threshold_days).toBe(10);
  });

  it("W4-05: a routine request carries no scope impact either (422)", () => {
    expect(classify({ ...base, requested_tier: "routine", impact_scope_count: 0 }).tier).toBe("routine");
    expect(() => classify({ ...base, requested_tier: "routine", impact_scope_count: 1 })).toThrow(FieldsError);
  });

  it("emergency: only a manager or admin may raise it; a member gets 403", () => {
    expect(classify({ ...base, is_emergency: true }).tier).toBe("emergency");
    expect(classify({ ...base, is_emergency: true, requester_role: "admin" }).tier).toBe("emergency");
    for (const role of ["member", "viewer", null]) {
      expect(() => classify({ ...base, is_emergency: true, requester_role: role })).toThrow(ScopeError);
    }
  });

  it("emergency beats the cost threshold and an asked-for tier", () => {
    expect(classify({ ...base, is_emergency: true, impact_cost: 1_000_000, requested_tier: "routine" }).tier).toBe("emergency");
  });

  it("only a change request can use the emergency path", () => {
    expect(() => classify({ ...base, kind: "task_deletion", is_emergency: true })).toThrow(FieldsError);
  });

  it("strategic only when an admin asks for it", () => {
    expect(classify({ ...base, requester_role: "admin", requested_tier: "strategic" }).tier).toBe("strategic");
    expect(() => classify({ ...base, requested_tier: "strategic" })).toThrow(ScopeError);
  });

  it("routine needs no cost and no schedule impact (422); with neither it is routine", () => {
    expect(classify({ ...base, requested_tier: "routine" }).tier).toBe("routine");
    expect(classify({ ...base, requested_tier: "routine", impact_cost: 0, impact_schedule_days: 0 }).tier).toBe("routine");
    expect(() => classify({ ...base, requested_tier: "routine", impact_cost: 10 })).toThrow(FieldsError);
    expect(() => classify({ ...base, requested_tier: "routine", impact_schedule_days: 3 })).toThrow(FieldsError);
  });

  it("only a change request can be routine", () => {
    expect(() => classify({ ...base, kind: "rebaseline", requested_tier: "routine" })).toThrow(FieldsError);
  });

  it("a project deletion starts at high_risk and a requester cannot lower it; a task deletion is normal", () => {
    expect(classify({ ...base, kind: "project_deletion" }).tier).toBe("high_risk");
    expect(classify({ ...base, kind: "project_deletion", requested_tier: "normal" }).tier).toBe("high_risk");
    expect(classify({ ...base, kind: "task_deletion" }).tier).toBe("normal");
    expect(classify({ ...base, kind: "rebaseline" }).tier).toBe("normal");
  });

  it("a requester may ask for MORE scrutiny", () => {
    expect(classify({ ...base, requested_tier: "high_risk" }).tier).toBe("high_risk");
  });

  it("a cost on a request already asked at high_risk stays high_risk (never lowered)", () => {
    expect(classify({ ...base, requested_tier: "high_risk", impact_cost: 5 }).tier).toBe("high_risk");
  });
});

describe("reclassifyOnEdit: editing the cost of a pending request cannot dodge the routing", () => {
  it("normal + a big cost -> high_risk", () => {
    expect(reclassifyOnEdit("normal", { impact_cost: 60_000, policy })).toBe("high_risk");
  });
  it("normal + a long slip -> high_risk; routine + a scope impact -> normal", () => {
    expect(reclassifyOnEdit("normal", { impact_schedule_days: 20, policy })).toBe("high_risk");
    expect(reclassifyOnEdit("routine", { impact_scope_count: 1, policy })).toBe("normal");
  });
  it("routine + any cost or days -> normal (or high_risk over the threshold)", () => {
    expect(reclassifyOnEdit("routine", { impact_cost: 5, policy })).toBe("normal");
    expect(reclassifyOnEdit("routine", { impact_schedule_days: 2, policy })).toBe("normal");
    expect(reclassifyOnEdit("routine", { impact_cost: 90_000, policy })).toBe("high_risk");
  });
  it("never goes down and never touches emergency / strategic / high_risk", () => {
    expect(reclassifyOnEdit("high_risk", { impact_cost: 0, policy })).toBe("high_risk");
    expect(reclassifyOnEdit("emergency", { impact_cost: 0, policy })).toBe("emergency");
    expect(reclassifyOnEdit("strategic", { impact_cost: 0, policy })).toBe("strategic");
  });
});

describe("routing (G2)", () => {
  it("an admin meets every tier; a manager meets the ones that ask for a manager", () => {
    for (const t of ["routine", "normal", "high_risk", "emergency", "strategic"] as const) expect(roleMeetsTier("admin", t, policy)).toBe(true);
    expect(roleMeetsTier("manager", "normal", policy)).toBe(true);
    expect(roleMeetsTier("manager", "routine", policy)).toBe(true);
    expect(roleMeetsTier("manager", "high_risk", policy)).toBe(false);
    expect(roleMeetsTier("manager", "emergency", policy)).toBe(false);
    expect(roleMeetsTier("manager", "strategic", policy)).toBe(false);
    expect(roleMeetsTier("member", "normal", policy)).toBe(false);
    expect(roleMeetsTier(null, "normal", policy)).toBe(false);
  });

  it("the workspace policy moves the line", () => {
    const p = policyOf({ tiers: { normal: { approver_role: "admin" }, high_risk: { approver_role: "manager" } } });
    expect(roleMeetsTier("manager", "normal", p)).toBe(false);
    expect(roleMeetsTier("manager", "high_risk", p)).toBe(true);
  });

  it("notifications go to admins only for an admin tier, managers and admins otherwise", () => {
    expect(eligibleRoles("high_risk", policy)).toEqual(["admin"]);
    expect(eligibleRoles("normal", policy)).toEqual(["admin", "manager"]);
  });

  it("requireTierRole: a token is judged by the role of the human behind it; wrong role -> 403 role_not_permitted", () => {
    const managerToken = { type: "token", principalRole: "manager" };
    expect(() => requireTierRole(managerToken, "normal", policy)).not.toThrow();
    try {
      requireTierRole(managerToken, "high_risk", policy);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeError);
      expect((e as ScopeError).code).toBe("role_not_permitted");
      expect((e as ScopeError).message).toMatch(/admin/);
    }
    expect(() => requireTierRole({ type: "user", role: "admin" }, "high_risk", policy)).not.toThrow();
    // the refusal names the tier and who may decide it
    expect(() => requireTierRole(managerToken, "high_risk", policy)).toThrow("Only admins can approve a high-risk request.");
    // D7: with fewer than two admins a manager passes an admin-level tier, and the call says so
    expect(requireTierRole(managerToken, "high_risk", policy, { singleAdmin: true })).toBe(true);
    expect(requireTierRole(managerToken, "normal", policy, { singleAdmin: true })).toBe(false);
    expect(() => requireTierRole({ type: "token", principalRole: "member" }, "normal", policy, { singleAdmin: true })).toThrow(ScopeError);
    expect(humanRoleOf({ type: "token", principalRole: null })).toBeNull();
  });
});

describe("timers (G3, G4)", () => {
  const now = new Date("2026-10-20T00:00:00.000Z");

  it("the deadline is now + the tier's turnaround; 0 hours means no timer; emergency has none (the retro clock applies)", () => {
    expect(deadlineFor("normal", policy, now)?.toISOString()).toBe("2026-10-22T00:00:00.000Z"); // 48 h
    expect(deadlineFor("routine", policy, now)?.toISOString()).toBe("2026-10-21T00:00:00.000Z"); // 24 h
    expect(deadlineFor("normal", policyOf({ tiers: { normal: { turnaround_hours: 0 } } }), now)).toBeNull();
    expect(deadlineFor("emergency", policy, now)).toBeNull();
  });

  it("the retro is due emergency_retro_hours (default 48) after the raise", () => {
    expect(retroDueAt(policy, now).toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(retroDueAt(policyOf({ emergency_retro_hours: 6 }), now).toISOString()).toBe("2026-10-20T06:00:00.000Z");
  });

  it("the reminder falls at 50% of the turnaround", () => {
    expect(reminderDueAt("2026-10-20T00:00:00.000Z", "2026-10-22T00:00:00.000Z").toISOString()).toBe("2026-10-21T00:00:00.000Z");
  });

  it("retro awaiting / overdue: flagged until decided, computed live", () => {
    const live = { is_emergency: true, retro_due_at: "2026-10-19T00:00:00.000Z", retro_decided_at: null };
    expect(isAwaitingRetro(live)).toBe(true);
    expect(isRetroOverdue(live, now)).toBe(true);
    expect(isRetroOverdue({ ...live, retro_due_at: "2026-10-25T00:00:00.000Z" }, now)).toBe(false);
    expect(isRetroOverdue({ ...live, retro_decided_at: "2026-10-19T12:00:00.000Z" }, now)).toBe(false);
    expect(isAwaitingRetro({ is_emergency: false })).toBe(false);
    expect(isRetroOverdue({ is_emergency: false, retro_due_at: "2020-01-01T00:00:00.000Z" }, now)).toBe(false);
  });
});

describe("validatePolicyInput / mergePolicy (the settings PATCH)", () => {
  it("accepts a subset and normalises it onto the defaults", () => {
    const r = validatePolicyInput({ tiers: { high_risk: { turnaround_hours: 24 } }, currency: "myr" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tiers.high_risk.turnaround_hours).toBe(24);
      expect(r.value.currency).toBe("MYR");
    }
  });

  it.each([
    ["auto_approve on a non-routine tier", { tiers: { normal: { auto_approve: true } } }, "approval_policy.tiers.normal.auto_approve"],
    ["auto_approve on high_risk", { tiers: { high_risk: { auto_approve: true } } }, "approval_policy.tiers.high_risk.auto_approve"],
    ["a bad role", { tiers: { normal: { approver_role: "member" } } }, "approval_policy.tiers.normal.approver_role"],
    ["an unknown tier", { tiers: { urgent: {} } }, "approval_policy.tiers.urgent"],
    ["an unknown rule key", { tiers: { normal: { colour: "red" } } }, "approval_policy.tiers.normal.colour"],
    ["negative hours", { tiers: { normal: { turnaround_hours: -1 } } }, "approval_policy.tiers.normal.turnaround_hours"],
    ["fractional hours", { tiers: { normal: { turnaround_hours: 1.5 } } }, "approval_policy.tiers.normal.turnaround_hours"],
    ["a negative threshold", { currency_threshold: -5 }, "approval_policy.currency_threshold"],
    ["a bad currency", { currency: "RINGGIT" }, "approval_policy.currency"],
    ["retro hours 0", { emergency_retro_hours: 0 }, "approval_policy.emergency_retro_hours"],
    ["an unknown top-level key", { sneaky: true }, "approval_policy.sneaky"],
  ])("refuses %s", (_label, input, field) => {
    const r = validatePolicyInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.field)).toContain(field);
  });

  it("auto_approve true is accepted on routine only", () => {
    expect(validatePolicyInput({ tiers: { routine: { auto_approve: true } } }).ok).toBe(true);
  });

  it("mergePolicy keeps what was stored and changes only what was sent", () => {
    const stored = { tiers: { normal: { turnaround_hours: 10, approver_role: "admin" } }, currency_threshold: 7 };
    const sent = { tiers: { normal: { turnaround_hours: 20 } } };
    const v = validatePolicyInput(sent);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const merged = mergePolicy(stored, v.value, sent);
      expect(merged.tiers.normal).toMatchObject({ turnaround_hours: 20, approver_role: "admin" });
      expect(merged.currency_threshold).toBe(7);
    }
  });
});

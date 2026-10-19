import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The daily approval timer (G3 reminder / escalation / routine auto-approve, G4 overdue retro flag).
const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/write")>()),
  writeAudit: writeAuditMock,
}));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: () => {},
  emitApprovalDecided: () => {},
  emitApprovalChanged: () => {},
}));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));

import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { runApprovalTimersForWorkspace, runApprovalTimerStep } from "./timers";

const NOW = new Date("2026-10-21T01:07:00.000Z");
const H = 3_600_000;
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * H).toISOString();

type RpcCall = { name: string; args: Record<string, unknown> };

/** The hub's in-memory database plus a mirror of nopm_auto_approve_routine (migration 0101). */
class TimerDb extends FakeDb {
  calls: RpcCall[] = [];
  async rpc(name?: string, args: Record<string, unknown> = {}) {
    if (name !== "nopm_auto_approve_routine") return super.rpc(name, args);
    this.calls.push({ name, args });
    const ws = this.rows("workspaces").find((w) => w.id === args.p_workspace_id);
    const policy = (ws?.approval_policy ?? {}) as { tiers?: { routine?: { auto_approve?: boolean } } };
    const err = (code: string, message: string) => ({ data: null, error: { code, message }, count: null });
    if (policy.tiers?.routine?.auto_approve !== true) return err("P0031", "AUTO_APPROVE_OFF");
    const cr = this.rows("change_requests").find((r) => r.id === args.p_id && r.workspace_id === args.p_workspace_id);
    if (!cr) return err("P0002", "NOT_FOUND");
    if (cr.tier !== "routine" || cr.is_emergency) return err("P0032", "NOT_ROUTINE");
    if (Number(cr.impact_cost ?? 0) !== 0 || Number(cr.impact_schedule_days ?? 0) !== 0) return err("P0032", "NOT_ROUTINE");
    if (cr.status !== "raised" && cr.status !== "under_review") return err("P0001", "ALREADY_DECIDED");
    if (!cr.approval_deadline_at || Date.parse(String(cr.approval_deadline_at)) > Date.parse(String(args.p_now))) return err("P0033", "NOT_DUE");
    const before = { ...cr };
    Object.assign(cr, { status: "approved", decided_by_label: "system:auto-approve (policy)", decided_principal_id: null, decided_at: String(args.p_now) });
    this.seed("approval_events", [{ workspace_id: WS, target_type: "change_request", target_id: cr.id, kind: "auto_approved" }]);
    this.seed("audit_log", [{ workspace_id: WS, action: "change_request.decide", target_id: cr.id, before, after: { ...cr }, actor_label: "system:auto-approve (policy)" }]);
    return { data: { ...cr }, error: null, count: null };
  }
}

let db: TimerDb;
const crRow = (id = "cr-1") => db.rows("change_requests").find((r) => r.id === id)!;
const events = (kind?: string) => db.rows("approval_events").filter((e) => !kind || e.kind === kind);
const notices = (type: string) => db.rows("notifications").filter((n) => n.type === type);

function cr(over: Record<string, unknown> = {}) {
  return {
    id: "cr-1",
    workspace_id: WS,
    project_id: "p1",
    reference_id: "CR-001",
    title: "Rename a label",
    status: "raised",
    tier: "normal",
    raised_at: at(-30),
    created_at: at(-30),
    approval_deadline_at: at(18), // a 48 h turnaround, 30 h in
    requested_principal_id: ids.requester,
    impact_cost: null,
    impact_schedule_days: null,
    is_emergency: false,
    ...over,
  };
}

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  db = new TimerDb();
  state.db = db;
  seedWorkspace(db);
  db.seed("projects", [{ id: "p1", workspace_id: WS, name: "Apollo" }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reminder at half the turnaround (G3)", () => {
  it("past 50% and before the deadline: the tier's approvers are reminded once, never the requester", async () => {
    db.seed("change_requests", [cr()]); // raised 30 h ago of 48 h
    const first = await runApprovalTimersForWorkspace(WS, NOW);
    expect(first).toMatchObject({ examined: 1, reminders: 1, escalated: 0, autoApproved: 0 });
    expect(events("reminder_sent")).toHaveLength(1);
    const to = notices("approval.reminder").map((n) => n.recipient_id);
    expect(new Set(to)).toEqual(new Set([ids.admin, ids.manager, ids.manager2]));
    expect(to).not.toContain(ids.requester);

    const second = await runApprovalTimersForWorkspace(WS, NOW);
    expect(second.reminders).toBe(0);
    expect(notices("approval.reminder")).toHaveLength(to.length);
  });

  it("a high_risk request reminds admins only", async () => {
    db.seed("change_requests", [cr({ tier: "high_risk" })]);
    await runApprovalTimersForWorkspace(WS, NOW);
    expect(notices("approval.reminder").map((n) => n.recipient_id)).toEqual([ids.admin]);
  });

  it("an assigned approver is reminded alone", async () => {
    db.seed("change_requests", [cr({ assigned_approver_id: ids.manager })]);
    await runApprovalTimersForWorkspace(WS, NOW);
    expect(notices("approval.reminder").map((n) => n.recipient_id)).toEqual([ids.manager]);
  });

  it("before 50%: nothing is sent", async () => {
    db.seed("change_requests", [cr({ raised_at: at(-2), created_at: at(-2), approval_deadline_at: at(46) })]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r).toMatchObject({ examined: 1, reminders: 0, escalated: 0 });
    expect(db.rows("notifications")).toHaveLength(0);
  });

  it("deletion requests and rebaselines are timed too", async () => {
    db.rows("deletion_requests")[0].tier = "normal";
    db.rows("deletion_requests")[0].created_at = at(-30);
    db.rows("deletion_requests")[0].approval_deadline_at = at(18);
    db.seed("rebaselines", [{ id: "rb-1", workspace_id: WS, project_id: "p1", version: 2, status: "pending_approval", tier: "normal", created_at: at(-30), approval_deadline_at: at(18) }]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r.reminders).toBe(2);
    expect(events("reminder_sent").map((e) => e.target_type).sort()).toEqual(["deletion_request", "rebaseline"]);
  });
});

describe("escalation past the deadline (G3)", () => {
  it("tells the admins once, and records it", async () => {
    db.seed("change_requests", [cr({ approval_deadline_at: at(-1) })]);
    const first = await runApprovalTimersForWorkspace(WS, NOW);
    expect(first).toMatchObject({ escalated: 1, autoApproved: 0 });
    expect(notices("approval.escalated").map((n) => n.recipient_id)).toEqual([ids.admin]);
    expect(events("escalated")).toHaveLength(1);
    const second = await runApprovalTimersForWorkspace(WS, NOW);
    expect(second.escalated).toBe(0);
    expect(notices("approval.escalated")).toHaveLength(1);
    // the request itself is untouched
    expect(crRow().status).toBe("raised");
  });

  it("a decided request is no longer chased", async () => {
    db.seed("change_requests", [cr({ approval_deadline_at: at(-1), status: "approved" })]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r.examined).toBe(0);
  });
});

describe("routine auto-approve (G3, assumption A1)", () => {
  const routine = (over: Record<string, unknown> = {}) => cr({ tier: "routine", approval_deadline_at: at(-1), ...over });
  const policyOn = { tiers: { routine: { auto_approve: true } } };

  it("is OFF by default: a routine request past its deadline is escalated, never approved, and the RPC is not even called", async () => {
    db.seed("change_requests", [routine()]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r).toMatchObject({ autoApproved: 0, escalated: 1 });
    expect(db.calls).toHaveLength(0);
    expect(crRow().status).toBe("raised");
  });

  it("with the policy on, a due routine request is approved by the system, once, and the requester is told", async () => {
    db.rows("workspaces")[0].approval_policy = policyOn;
    db.seed("change_requests", [routine()]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r).toMatchObject({ autoApproved: 1, escalated: 0 });
    expect(crRow()).toMatchObject({ status: "approved", decided_principal_id: null, decided_by_label: "system:auto-approve (policy)" });
    expect(db.rows("audit_log").filter((a) => a.action === "change_request.decide")).toHaveLength(1);
    expect(notices("approval.auto_approved").map((n) => n.recipient_id)).toEqual([ids.requester]);
    expect(events("escalated")).toHaveLength(0);

    const again = await runApprovalTimersForWorkspace(WS, NOW);
    expect(again.autoApproved).toBe(0);
    expect(db.calls).toHaveLength(1);
  });

  it.each([["normal"], ["high_risk"], ["strategic"], ["emergency"]])("never for the %s tier, even with the policy on: the RPC is not called", async (tier) => {
    db.rows("workspaces")[0].approval_policy = policyOn;
    db.seed("change_requests", [cr({ tier, approval_deadline_at: at(-1) })]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r.autoApproved).toBe(0);
    expect(db.calls).toHaveLength(0);
    expect(crRow().status).toBe("raised");
  });

  it("a deletion request or rebaseline is never auto-approved, whatever its tier", async () => {
    db.rows("workspaces")[0].approval_policy = policyOn;
    db.rows("deletion_requests")[0].tier = "routine";
    db.rows("deletion_requests")[0].created_at = at(-30);
    db.rows("deletion_requests")[0].approval_deadline_at = at(-1);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r.autoApproved).toBe(0);
    expect(db.calls).toHaveLength(0);
    expect(db.rows("deletion_requests")[0].status).toBe("pending");
  });

  it("a routine request that carries money is refused by the database function and is escalated instead", async () => {
    db.rows("workspaces")[0].approval_policy = policyOn;
    db.seed("change_requests", [routine({ impact_cost: 5 })]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(db.calls).toHaveLength(1); // the TS layer asked, the database said no
    expect(r).toMatchObject({ autoApproved: 0, escalated: 1, failed: 0 });
    expect(crRow().status).toBe("raised");
  });

  it("not yet due: untouched", async () => {
    db.rows("workspaces")[0].approval_policy = policyOn;
    db.seed("change_requests", [routine({ approval_deadline_at: at(5), raised_at: at(-1), created_at: at(-1) })]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r.autoApproved).toBe(0);
    expect(db.calls).toHaveLength(0);
  });
});

describe("Q1: the retro timer is retired", () => {
  const emergency = (over: Record<string, unknown> = {}) =>
    cr({ tier: "emergency", status: "implemented", is_emergency: true, approval_deadline_at: null, retro_due_at: at(-2), retro_decided_at: null, reference_id: "CR-009", ...over });

  it("an old emergency row that still reads overdue is not looked at, flagged or announced", async () => {
    db.seed("change_requests", [emergency()]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r.examined).toBe(0);
    expect(events("retro_overdue")).toHaveLength(0);
    expect(notices("approval.escalated")).toHaveLength(0);
  });

  it("does not write to the request row (an approver's pinned version stays valid)", async () => {
    db.seed("change_requests", [emergency({ updated_at: "2026-10-20T00:00:00.000Z" })]);
    await runApprovalTimersForWorkspace(WS, NOW);
    expect(crRow().updated_at).toBe("2026-10-20T00:00:00.000Z");
  });

  it("an emergency raised since the decision (approved, no deadline) is never reminded or escalated", async () => {
    db.seed("change_requests", [emergency({ status: "approved", retro_due_at: null, retro_decided_at: at(-3), retro_outcome: "not_required" })]);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r).toMatchObject({ reminders: 0, escalated: 0, autoApproved: 0 });
    expect(r).not.toHaveProperty("retroOverdue");
  });
});

describe("W4-25: the timer pages through every waiting item", () => {
  it("looks at ALL of 1,150 overdue requests, not just the first 500", async () => {
    const rows = Array.from({ length: 1150 }, (_, i) => cr({ id: "cr-" + String(i).padStart(5, "0"), reference_id: "CR-" + i, approval_deadline_at: at(-1 - i / 1000) }));
    db.seed("change_requests", rows);
    const r = await runApprovalTimersForWorkspace(WS, NOW);
    expect(r.examined).toBe(1150);
    expect(r.escalated).toBe(1150);
    expect(events("escalated")).toHaveLength(1150);
  });
});

describe("one audit row per workspace per run (approval.timer_run)", () => {
  it("writes exactly one row with the counts when the timer had something to look at", async () => {
    db.seed("change_requests", [cr(), cr({ id: "cr-2", approval_deadline_at: at(-1) })]);
    await runApprovalTimersForWorkspace(WS, NOW);
    const rows = writeAuditMock.mock.calls.map((c) => c[0] as { action: string; after: Record<string, unknown>; actor: Record<string, unknown>; workspaceId: string; targetType: string; targetId: string }).filter((a) => a.action === "approval.timer_run");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: WS, targetType: "workspace", targetId: WS });
    expect(rows[0].after).toMatchObject({ examined: 2, reminders: 1, escalated: 1, autoApproved: 0 });
    expect(rows[0].actor).toMatchObject({ type: "token", label: "system:approval-timer" });
  });

  it("a workspace with nothing waiting writes nothing (no mutation, no row)", async () => {
    await runApprovalTimersForWorkspace(WS, NOW);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

describe("the scheduler step", () => {
  it("walks every workspace and sums the counts; one workspace failing does not stop the others", async () => {
    db.seed("workspaces", [{ id: "22222222-2222-4222-8222-222222222222", name: "Other" }]);
    db.seed("change_requests", [cr({ approval_deadline_at: at(-1) })]);
    const summary = await runApprovalTimerStep(NOW, Date.now() + 60_000);
    expect(summary.workspaces).toBe(2);
    expect(summary.escalated).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("stops starting workspaces once the deadline has passed and says so", async () => {
    const summary = await runApprovalTimerStep(NOW, Date.now() - 1);
    expect(summary).toMatchObject({ workspaces: 1, skippedForDeadline: 1, examined: 0 });
  });
});
